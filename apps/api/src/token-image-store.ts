import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import pg from "pg";
import {
  TokenImageError,
  tokenImageUrl,
  transformedTokenImage,
  type TokenImageReason,
} from "@pools/token-image";
import { catalogCte } from "./catalog-read";

/** One `token_images` row: the encoded icon, or the last rejection and when
 * the source may be tried again. `sourceUrl` is the catalog value the row was
 * produced from, so a replaced image_url is encoded again on its next view. */
export interface StoredTokenImage {
  sourceUrl: string;
  webp: Buffer | null;
  contentHash: string | null;
  encodedAt: Date;
  rejection: TokenImageReason | null;
  attempts: number;
  retryAfter: Date | null;
}
export interface TokenImageLookup {
  /** False when the pool is not in the blended catalog. */
  present: boolean;
  imageUrl: string | null;
  stored: StoredTokenImage | null;
}
export interface TokenImageStore {
  lookup(poolId: string): Promise<TokenImageLookup>;
  save(poolId: string, entry: StoredTokenImage): Promise<void>;
  close(): Promise<void>;
}

/** The store's own small pool: the reader's connections stay READ ONLY and
 * this is the only table the API writes. Never used for another statement. */
export function createTokenImageStore(
  url = process.env.DATABASE_URL,
  testSchema?: string,
): TokenImageStore {
  if (!url) throw Error("DATABASE_URL is required");
  if (testSchema && !/^api_test_[a-z0-9_]+$/.test(testSchema))
    throw Error("Invalid test schema");
  const pool = new pg.Pool({
    connectionString: url,
    max: 3,
    connectionTimeoutMillis: 2000,
    idleTimeoutMillis: 30000,
    statement_timeout: 2000,
    query_timeout: 3000,
    application_name: "pools-read-api-images",
    ...(testSchema ? { options: `-c search_path=${testSchema}` } : {}),
  });
  pool.on("error", () =>
    process.stderr.write('{"event":"idle_database_connection_error"}\n'),
  );
  return {
    async lookup(poolId) {
      const { rows } = await pool.query(
        `${catalogCte} SELECT c.image_url, i.source_url, i.webp, i.content_hash, i.encoded_at,
          i.rejection, i.attempts, i.retry_after
        FROM catalog c LEFT JOIN token_images i ON i.chain_id=c.chain_id AND i.pool_id=c.pool_id
        WHERE c.chain_id=4663 AND c.pool_id=$1`,
        [poolId],
      );
      const row = rows[0];
      if (!row) return { present: false, imageUrl: null, stored: null };
      return {
        present: true,
        imageUrl: row.image_url ?? null,
        stored:
          row.source_url === null
            ? null
            : {
                sourceUrl: row.source_url,
                webp: row.webp ?? null,
                contentHash: row.content_hash ?? null,
                encodedAt: row.encoded_at,
                rejection: row.rejection ?? null,
                attempts: row.attempts,
                retryAfter: row.retry_after ?? null,
              },
      };
    },
    async save(poolId, entry) {
      await pool.query(
        `INSERT INTO token_images (chain_id,pool_id,source_url,webp,content_hash,byte_size,encoded_at,rejection,attempts,retry_after)
        VALUES (4663,$1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT (chain_id,pool_id) DO UPDATE SET source_url=EXCLUDED.source_url, webp=EXCLUDED.webp,
          content_hash=EXCLUDED.content_hash, byte_size=EXCLUDED.byte_size, encoded_at=EXCLUDED.encoded_at,
          rejection=EXCLUDED.rejection, attempts=EXCLUDED.attempts, retry_after=EXCLUDED.retry_after`,
        [
          poolId,
          entry.sourceUrl,
          entry.webp,
          entry.contentHash,
          entry.webp ? entry.webp.length : null,
          entry.encodedAt,
          entry.rejection,
          entry.attempts,
          entry.retryAfter,
        ],
      );
    },
    async close() {
      await pool.end();
    },
  };
}

export interface TokenImageSettings {
  /** Upstream budget per attempt (DNS, download, decode, encode) and the
   * longest a request waits for a fetch slot. */
  deadlineMs: number;
  /** Process-wide bound on concurrent upstream fetches. */
  concurrency: number;
  /** First negative lifetime after a transient failure; doubles per repeat. */
  retrySeconds: number;
  /** Negative lifetime for source policy rejections and the backoff ceiling. */
  rejectedSeconds: number;
}
export const defaultTokenImageSettings: TokenImageSettings = {
  deadlineMs: 4000,
  concurrency: 8,
  retrySeconds: 300,
  rejectedSeconds: 86400,
};
export function tokenImageSettings(
  env: Record<string, string | undefined> = process.env,
): TokenImageSettings {
  const read = (name: string, fallback: number, min: number, max: number) => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const value = /^\d{1,9}$/.test(raw) ? Number(raw) : NaN;
    if (!(value >= min && value <= max))
      throw Error(`${name} must be an integer between ${min} and ${max}`);
    return value;
  };
  const d = defaultTokenImageSettings;
  return {
    deadlineMs: read("TOKEN_IMAGE_DEADLINE_MS", d.deadlineMs, 500, 10000),
    concurrency: read("TOKEN_IMAGE_CONCURRENCY", d.concurrency, 1, 32),
    retrySeconds: read("TOKEN_IMAGE_RETRY_SECONDS", d.retrySeconds, 5, 86400),
    rejectedSeconds: read(
      "TOKEN_IMAGE_REJECTED_SECONDS",
      d.rejectedSeconds,
      60,
      2592000,
    ),
  };
}
/** Stored icons are keyed by pool and change only with a catalog metadata
 * replacement, so browsers keep them a day and edges a month, serving stale
 * copies while revalidating against the ETag. */
export const tokenImageCacheControl =
  "public, max-age=86400, s-maxage=2592000, stale-while-revalidate=604800";

export type TokenImageOutcome =
  | { kind: "image"; bytes: Buffer; etag: string }
  | { kind: "missing"; error: string; reason?: string; maxAge: number }
  | { kind: "busy" };
export interface TokenImageService {
  resolve(poolId: string): Promise<TokenImageOutcome>;
  close(): Promise<void>;
}
type Transform = (source: string, signal: AbortSignal) => Promise<Buffer>;

/** FIFO fetch slots with a bounded waiting line; a waiter that outlives its
 * budget leaves the line rather than starting late. */
function createSlots(size: number, maxWaiting: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  function release() {
    const next = waiting.shift();
    if (next) next();
    else active--;
  }
  return async (waitMs: number): Promise<(() => void) | null> => {
    if (active < size) active++;
    else {
      if (waiting.length >= maxWaiting) return null;
      const granted = await new Promise<boolean>((resolve) => {
        const grant = () => {
          clearTimeout(timer);
          resolve(true);
        };
        const timer = setTimeout(() => {
          waiting.splice(waiting.indexOf(grant), 1);
          resolve(false);
        }, waitMs);
        waiting.push(grant);
      });
      if (!granted) return null;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      release();
    };
  };
}

/** Serves stored icons and fills the store on a pool's first view. A request
 * is the only trigger: there is no warm-up, sweep or prefetch. Concurrent
 * first views of one pool share a single attempt in this process. */
export function createTokenImageService(
  store: TokenImageStore,
  {
    settings = defaultTokenImageSettings,
    transform = (source, signal) => transformedTokenImage(source, signal),
    now = Date.now,
  }: {
    settings?: TokenImageSettings;
    transform?: Transform;
    now?: () => number;
  } = {},
): TokenImageService {
  const acquire = createSlots(settings.concurrency, settings.concurrency * 4);
  const pending = new Map<string, Promise<TokenImageOutcome>>();
  const accepted = (source: string) => {
    try {
      tokenImageUrl(source);
      return true;
    } catch {
      return false;
    }
  };
  const negativeSeconds = (reason: TokenImageReason, attempts: number) =>
    reason === "source_rejected"
      ? settings.rejectedSeconds
      : Math.min(
          settings.retrySeconds * 2 ** Math.min(attempts - 1, 30),
          settings.rejectedSeconds,
        );
  async function persist(poolId: string, entry: StoredTokenImage) {
    try {
      await store.save(poolId, entry);
    } catch {
      // The response is already decided; the next view repeats the attempt.
      process.stderr.write('{"event":"token_image_store_failed"}\n');
    }
  }
  async function reject(
    poolId: string,
    source: string,
    reason: TokenImageReason,
    attempts: number,
  ): Promise<TokenImageOutcome> {
    const seconds = negativeSeconds(reason, attempts);
    const at = now();
    await persist(poolId, {
      sourceUrl: source,
      webp: null,
      contentHash: null,
      encodedAt: new Date(at),
      rejection: reason,
      attempts,
      retryAfter: new Date(at + seconds * 1000),
    });
    return {
      kind: "missing",
      error: "image_unavailable",
      reason,
      maxAge: seconds,
    };
  }
  async function attempt(
    poolId: string,
    source: string,
    previous: StoredTokenImage | null,
  ): Promise<TokenImageOutcome> {
    const attempts = previous?.rejection ? previous.attempts + 1 : 1;
    if (!accepted(source))
      return reject(poolId, source, "source_rejected", attempts);
    const release = await acquire(settings.deadlineMs);
    if (!release) return { kind: "busy" };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), settings.deadlineMs);
    let bytes: Buffer;
    try {
      bytes = await transform(source, controller.signal);
    } catch (error) {
      const reason =
        error instanceof TokenImageError
          ? error.reason
          : controller.signal.aborted
            ? "timeout"
            : "decode_rejected";
      return reject(poolId, source, reason, attempts);
    } finally {
      clearTimeout(timer);
      release();
    }
    const contentHash = createHash("sha256").update(bytes).digest("hex");
    await persist(poolId, {
      sourceUrl: source,
      webp: bytes,
      contentHash,
      encodedAt: new Date(now()),
      rejection: null,
      attempts,
      retryAfter: null,
    });
    return { kind: "image", bytes, etag: `"${contentHash}"` };
  }
  return {
    async resolve(poolId) {
      const inFlight = pending.get(poolId);
      if (inFlight) return inFlight;
      const { present, imageUrl, stored } = await store.lookup(poolId);
      if (!present)
        return {
          kind: "missing",
          error: "pool_not_indexed",
          maxAge: settings.retrySeconds,
        };
      const source = imageUrl?.trim() ? imageUrl : null;
      if (!source)
        return {
          kind: "missing",
          error: "image_unavailable",
          reason: "no_source",
          maxAge: settings.rejectedSeconds,
        };
      const current = stored?.sourceUrl === source ? stored : null;
      if (current?.webp && current.contentHash)
        return {
          kind: "image",
          bytes: current.webp,
          etag: `"${current.contentHash}"`,
        };
      const remaining = current?.retryAfter
        ? Math.ceil((current.retryAfter.getTime() - now()) / 1000)
        : 0;
      // A policy rejection outlives a deploy that widens the allowlist only
      // until its next view: the pure check runs again before trusting it.
      if (
        current?.rejection &&
        remaining > 0 &&
        !(current.rejection === "source_rejected" && accepted(source))
      )
        return {
          kind: "missing",
          error: "image_unavailable",
          reason: current.rejection,
          maxAge: remaining,
        };
      let task = pending.get(poolId);
      if (!task) {
        task = attempt(poolId, source, current).finally(() =>
          pending.delete(poolId),
        );
        pending.set(poolId, task);
      }
      return task;
    },
    close: () => store.close(),
  };
}

function etagMatches(header: string | string[] | undefined, etag: string) {
  if (!header) return false;
  // If-None-Match uses weak comparison: W/"x" matches "x".
  return String(header)
    .split(",")
    .map((value) => value.trim().replace(/^W\//u, ""))
    .some((value) => value === "*" || value === etag);
}

/** Writes one outcome. The route inherits the server's JSON content type and
 * `no-store` default; images and cacheable 404s replace them here. */
export function respondTokenImage(
  req: IncomingMessage,
  res: ServerResponse,
  outcome: TokenImageOutcome,
) {
  const head = req.method === "HEAD";
  if (outcome.kind === "busy") {
    res.setHeader("Retry-After", "5");
    res.statusCode = 503;
    res.end(head ? undefined : '{"error":"busy"}');
    return;
  }
  if (outcome.kind === "missing") {
    res.setHeader(
      "Cache-Control",
      `public, max-age=${outcome.maxAge}, s-maxage=${outcome.maxAge}`,
    );
    res.statusCode = 404;
    res.end(
      head
        ? undefined
        : JSON.stringify({
            error: outcome.error,
            ...(outcome.reason ? { reason: outcome.reason } : {}),
          }),
    );
    return;
  }
  res.setHeader("Content-Type", "image/webp");
  res.setHeader("ETag", outcome.etag);
  res.setHeader("Cache-Control", tokenImageCacheControl);
  res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
  res.setHeader("Content-Disposition", 'inline; filename="token.webp"');
  if (etagMatches(req.headers["if-none-match"], outcome.etag)) {
    res.statusCode = 304;
    res.end();
    return;
  }
  res.setHeader("Content-Length", String(outcome.bytes.length));
  res.statusCode = 200;
  res.end(head ? undefined : outcome.bytes);
}
