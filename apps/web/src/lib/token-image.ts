// This route is a proxy over the read API's token icon store. The store owns
// the whole upstream pipeline - host allowlist, DNS checks, size and
// content-type limits, Sharp decode and WebP re-encode - and keeps one encoded
// 128 px icon per pool, so the website only relays its bytes, its validator
// and the lifetimes it states. Nothing here fetches a creator host or an IPFS
// gateway, and nothing prefetches: a browser request is the only trigger.
export const imageProxy = {
  // The store caps one request at 12 s (queueing for a fetch slot plus its
  // 10 s upstream budget), so a first view receives the store's own answer
  // before this deadline; later views are one primary-key read.
  timeoutMs: 13000,
  // The store caps its output at 256 KiB; this only bounds what we buffer.
  maxBytes: 512 * 1024,
} as const;
// Lifetimes in seconds. The store states the authoritative ones in its own
// Cache-Control and these are the fallbacks for a header it did not send.
// `absent` is also the store's shortest stated negative lifetime, used when no
// read API is configured at all. `invalid` answers a request that can never
// become valid. Nothing is immutable: a creator can replace an image, and the
// store re-encodes it on the pool's next view.
export const imageLifetimes = {
  browser: 86400,
  edge: 2592000,
  staleWhileRevalidate: 604800,
  absent: 300,
  invalid: 86400,
  retryAfter: 5,
  maxSeconds: 2592000,
} as const;

const poolPattern = /^0x[0-9a-f]{64}$/i;
// RFC 9110 entity-tag: a quoted string of etagc octets. Only a strong
// validator is relayed; the store's tag is its content hash.
const etagPattern = /^"[\x21\x23-\x7e]{1,128}"$/u;
const servedHeaders = {
  "Content-Type": "image/webp",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; sandbox",
  "Content-Disposition": 'inline; filename="token.webp"',
} as const;

/** One comma-delimited `name=seconds` directive, clamped, or null when absent. */
function directiveSeconds(header: string | null, name: string): number | null {
  for (const directive of (header ?? "").split(",")) {
    const separator = directive.indexOf("=");
    if (separator < 0) continue;
    if (directive.slice(0, separator).trim().toLowerCase() !== name) continue;
    const value = directive
      .slice(separator + 1)
      .trim()
      .replace(/^"|"$/gu, "");
    // A numeric lifetime is clamped; anything else falls back to ours.
    return value.length <= 18 && /^\d+$/u.test(value)
      ? Math.min(Number(value), imageLifetimes.maxSeconds)
      : null;
  }
  return null;
}
const strongEntityTag = (header: string | null) =>
  header && etagPattern.test(header) ? header : null;
// A client validator is relayed as sent so the store does its own weak
// comparison; only a header that cannot be a valid field value is dropped.
const relayedValidator = (header: string | null) =>
  header && header.length <= 1024 && /^[\x20-\x7e]+$/u.test(header)
    ? header
    : null;
const retryAfterSeconds = (header: string | null) => {
  const seconds = Number(header);
  return /^\d{1,4}$/u.test(header ?? "") && seconds >= 1
    ? Math.min(seconds, 60)
    : imageLifetimes.retryAfter;
};
const advertisedLength = (header: string | null) =>
  /^\d{1,10}$/u.test(header ?? "") && Number(header) <= imageProxy.maxBytes
    ? Number(header)
    : null;

export type StoredLifetimes = {
  browser: number;
  edge: number;
  staleWhileRevalidate: number;
};
const storedLifetimes = (header: string | null): StoredLifetimes => ({
  browser: directiveSeconds(header, "max-age") ?? imageLifetimes.browser,
  edge: directiveSeconds(header, "s-maxage") ?? imageLifetimes.edge,
  staleWhileRevalidate:
    directiveSeconds(header, "stale-while-revalidate") ??
    imageLifetimes.staleWhileRevalidate,
});
const servedCacheControl = (lifetimes: StoredLifetimes) =>
  `public, max-age=${lifetimes.browser}, s-maxage=${lifetimes.edge}, stale-while-revalidate=${lifetimes.staleWhileRevalidate}`;
const negativeCacheControl = (seconds: number) =>
  `public, max-age=${seconds}, s-maxage=${seconds}`;

export type StoredImageResult =
  /** The store served the icon; `bytes` is null for a HEAD view. */
  | {
      state: "stored";
      etag: string | null;
      bytes: Uint8Array<ArrayBuffer> | null;
      length: number | null;
      lifetimes: StoredLifetimes;
    }
  /** The store matched the client's validator. */
  | { state: "unchanged"; etag: string | null; lifetimes: StoredLifetimes }
  /** No icon for this pool, for as long as the store says it will not retry. */
  | { state: "absent"; seconds: number }
  /** The store is saturated, rate limited or unreachable; retry, cache nothing. */
  | { state: "busy"; retryAfter: number };

export type StoredImageView = {
  method: "GET" | "HEAD";
  ifNoneMatch: string | null;
};
export type StoredImageSource = (
  poolId: string,
  view: StoredImageView,
  signal: AbortSignal,
) => Promise<StoredImageResult>;

/** The read API base, validated the same way the product proxy validates it. */
function storeOrigin(): URL | null {
  const configured = process.env.INDEXER_API_URL;
  if (!configured || process.env.CHAIN_REFRESH_DISABLED === "1") return null;
  let origin: URL;
  try {
    origin = new URL(configured);
  } catch {
    return null;
  }
  return ["http:", "https:"].includes(origin.protocol) &&
    !origin.username &&
    !origin.password &&
    origin.pathname === "/" &&
    !origin.search &&
    !origin.hash
    ? origin
    : null;
}

async function boundedBytes(
  response: Response,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const header = response.headers.get("content-length");
  const advertised = advertisedLength(header);
  if ((header !== null && advertised === null) || !response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > imageProxy.maxBytes) return null;
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  if (!length || (advertised !== null && length !== advertised)) return null;
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Reads one pool's stored icon from the read API's token icon store
 * (`GET`/`HEAD /v1/pools/<poolId>/image`, documented under "Token icon store"
 * in `apps/api/README.md`). Only the client's validator is forwarded; no
 * browser cookie, authorization or referer header reaches the store, and no
 * store response header reaches the browser except through the typed result.
 */
export const resolveStoredImage: StoredImageSource = async (
  poolId,
  view,
  signal,
) => {
  const origin = storeOrigin();
  if (!origin) return { state: "absent", seconds: imageLifetimes.absent };
  const busy = {
    state: "busy",
    retryAfter: imageLifetimes.retryAfter,
  } as const;
  let response: Response;
  try {
    response = await fetch(new URL(`/v1/pools/${poolId}/image`, origin), {
      method: view.method,
      cache: "no-store",
      redirect: "error",
      signal,
      headers: {
        Accept: "image/webp",
        ...(view.ifNoneMatch ? { "If-None-Match": view.ifNoneMatch } : {}),
      },
    });
  } catch {
    return busy;
  }
  const cacheControl = response.headers.get("cache-control");
  const etag = strongEntityTag(response.headers.get("etag"));
  try {
    if (response.status === 304)
      return {
        state: "unchanged",
        etag,
        lifetimes: storedLifetimes(cacheControl),
      };
    // The store's 404 is a JSON reason the website never shows; the generated
    // icon is the fallback, cached for exactly as long as the store states.
    if (response.status === 404)
      return {
        state: "absent",
        seconds:
          directiveSeconds(cacheControl, "max-age") ?? imageLifetimes.absent,
      };
    // 503 is the store's own busy signal and 429 its request budget. Both are
    // this gateway being temporarily unable to serve, not the visitor's doing.
    if (response.status === 503 || response.status === 429)
      return {
        state: "busy",
        retryAfter: retryAfterSeconds(response.headers.get("retry-after")),
      };
    if (
      response.status !== 200 ||
      (response.headers.get("content-type") ?? "")
        .split(";")[0]
        .trim()
        .toLowerCase() !== "image/webp"
    )
      return busy;
    const lifetimes = storedLifetimes(cacheControl);
    if (view.method === "HEAD")
      return {
        state: "stored",
        etag,
        bytes: null,
        length: advertisedLength(response.headers.get("content-length")),
        lifetimes,
      };
    const bytes = await boundedBytes(response);
    return bytes
      ? { state: "stored", etag, bytes, length: bytes.byteLength, lifetimes }
      : busy;
  } catch {
    return busy;
  } finally {
    // A body left unread on an early return would hold the connection open.
    if (response.body && !response.bodyUsed && !response.body.locked)
      await response.body.cancel().catch(() => {});
  }
};

/** Factory makes the store seam testable; no pool scan or image prefetch. */
export function createTokenImageHandler(
  storedImage: StoredImageSource = resolveStoredImage,
  timeoutMs: number = imageProxy.timeoutMs,
) {
  return async (request: Request, poolId: string): Promise<Response> => {
    if (!poolPattern.test(poolId) || new URL(request.url).search)
      // Refused before the store is contacted. The browser and edge may hold
      // the empty response for a day; a malformed request cannot become valid.
      return new Response(null, {
        status: 400,
        headers: {
          "Cache-Control": negativeCacheControl(imageLifetimes.invalid),
        },
      });
    const head = request.method === "HEAD";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let result: StoredImageResult;
    try {
      result = await storedImage(
        poolId.toLowerCase(),
        {
          method: head ? "HEAD" : "GET",
          ifNoneMatch: relayedValidator(request.headers.get("if-none-match")),
        },
        controller.signal,
      );
    } catch {
      result = { state: "busy", retryAfter: imageLifetimes.retryAfter };
    } finally {
      clearTimeout(timer);
    }
    if (result.state === "busy")
      return new Response(null, {
        status: 503,
        headers: {
          "Cache-Control": "no-store",
          "Retry-After": String(result.retryAfter),
        },
      });
    if (result.state === "absent")
      return new Response(null, {
        status: 404,
        headers: {
          ...servedHeaders,
          "Cache-Control": negativeCacheControl(result.seconds),
        },
      });
    const cacheControl = servedCacheControl(result.lifetimes);
    if (result.state === "unchanged")
      return new Response(null, {
        status: 304,
        headers: {
          ...servedHeaders,
          "Cache-Control": cacheControl,
          ...(result.etag ? { ETag: result.etag } : {}),
        },
      });
    return new Response(result.bytes, {
      status: 200,
      headers: {
        ...servedHeaders,
        "Cache-Control": cacheControl,
        ...(result.etag ? { ETag: result.etag } : {}),
        ...(result.length === null
          ? {}
          : { "Content-Length": String(result.length) }),
      },
    });
  };
}
