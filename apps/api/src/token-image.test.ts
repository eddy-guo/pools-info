import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { TokenImageError } from "@pools/token-image";
import { parseRequest, RequestError } from "./request";
import { createApi } from "./server";
import {
  createTokenImageService,
  defaultTokenImageSettings,
  tokenImageSettings,
  type StoredTokenImage,
  type TokenImageStore,
} from "./token-image-store";

const poolId = `0x${"a".repeat(64)}`;
const source = "https://pools.trade/icon.png";
const webp = Buffer.from("RIFF....WEBPVP8 fake-but-fine");
const etag = `"${createHash("sha256").update(webp).digest("hex")}"`;

/** In-memory store: the catalog and rows are plain maps. */
function memoryStore(catalog: Record<string, string | null> = {}) {
  const rows = new Map<string, StoredTokenImage>();
  const store: TokenImageStore & {
    rows: Map<string, StoredTokenImage>;
    lookups: number;
    failSave: boolean;
  } = {
    rows,
    lookups: 0,
    failSave: false,
    async lookup(id) {
      store.lookups++;
      return {
        present: id in catalog,
        imageUrl: catalog[id] ?? null,
        stored: rows.get(id) ?? null,
      };
    },
    async save(id, entry) {
      if (store.failSave) throw Error("postgres://user:secret@host down");
      rows.set(id, entry);
    },
    async close() {},
  };
  return store;
}

test("image route parses only the exact path and rejects every query parameter", () => {
  const request = parseRequest(`/v1/pools/${poolId.toUpperCase()}/image`);
  assert.equal(request.route, "pool-image");
  assert.equal(request.poolId, poolId);
  for (const url of [
    `/v1/pools/${poolId}/image?url=http://127.0.0.1/`,
    `/v1/pools/${poolId}/image?window=24h`,
    `/v1/pools/${poolId}/image/`,
    `/v1/pools/${poolId.slice(0, 40)}/image`,
    "/v1/pools/image",
  ])
    assert.throws(() => parseRequest(url), RequestError, url);
});

test("settings come from bounded integer variables", () => {
  assert.deepEqual(tokenImageSettings({}), defaultTokenImageSettings);
  assert.deepEqual(
    tokenImageSettings({
      TOKEN_IMAGE_DEADLINE_MS: "2500",
      TOKEN_IMAGE_CONCURRENCY: "2",
      TOKEN_IMAGE_RETRY_SECONDS: "30",
      TOKEN_IMAGE_REJECTED_SECONDS: "3600",
      TOKEN_IMAGE_REQUEST_CAP_MS: "4000",
      TOKEN_IMAGE_TIMEOUT_REJECTED_SECONDS: "900",
    }),
    {
      deadlineMs: 2500,
      concurrency: 2,
      retrySeconds: 30,
      rejectedSeconds: 3600,
      requestCapMs: 4000,
      timeoutRejectedSeconds: 900,
    },
  );
  for (const [name, value] of [
    ["TOKEN_IMAGE_DEADLINE_MS", "0"],
    ["TOKEN_IMAGE_DEADLINE_MS", "abc"],
    ["TOKEN_IMAGE_CONCURRENCY", "33"],
    ["TOKEN_IMAGE_RETRY_SECONDS", "-1"],
    ["TOKEN_IMAGE_REJECTED_SECONDS", "1.5"],
    ["TOKEN_IMAGE_REQUEST_CAP_MS", "100"],
    ["TOKEN_IMAGE_TIMEOUT_REJECTED_SECONDS", "0"],
  ])
    assert.throws(() => tokenImageSettings({ [name]: value }), RegExp(name));
});

test("first view encodes once, stores the bytes and later views come from the store", async () => {
  const store = memoryStore({ [poolId]: source });
  let transforms = 0;
  const service = createTokenImageService(store, {
    transform: async () => {
      transforms++;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return webp;
    },
  });
  const outcomes = await Promise.all(
    Array.from({ length: 6 }, () => service.resolve(poolId)),
  );
  assert.equal(transforms, 1, "burst of first views fetches once");
  for (const outcome of outcomes)
    assert.deepEqual(outcome, { kind: "image", bytes: webp, etag });
  const row = store.rows.get(poolId)!;
  assert.equal(row.sourceUrl, source);
  assert.equal(row.contentHash, etag.slice(1, -1));
  assert.equal(row.rejection, null);
  assert.equal(row.attempts, 1);
  assert.deepEqual(await service.resolve(poolId), {
    kind: "image",
    bytes: webp,
    etag,
  });
  assert.equal(transforms, 1);
});

test("missing pools and pools without a source never fetch", async () => {
  const store = memoryStore({ [`0x${"b".repeat(64)}`]: "   " });
  const service = createTokenImageService(store, {
    transform: async () => assert.fail("no fetch"),
  });
  assert.deepEqual(await service.resolve(poolId), {
    kind: "missing",
    error: "pool_not_indexed",
    maxAge: 300,
  });
  assert.deepEqual(await service.resolve(`0x${"b".repeat(64)}`), {
    kind: "missing",
    error: "image_unavailable",
    reason: "no_source",
    maxAge: 86400,
  });
  assert.equal(store.rows.size, 0);
});

test("policy rejections are stored for a day without a fetch and re-checked purely on each view", async () => {
  let clock = 1_000_000_000_000;
  const store = memoryStore({
    [poolId]: "https://desperate-moccasin-minnow.myfilebase.com/x.png",
  });
  let transforms = 0;
  const service = createTokenImageService(store, {
    now: () => clock,
    transform: async () => {
      transforms++;
      return webp;
    },
  });
  assert.deepEqual(await service.resolve(poolId), {
    kind: "missing",
    error: "image_unavailable",
    reason: "source_rejected",
    maxAge: 86400,
  });
  assert.equal(transforms, 0);
  const row = store.rows.get(poolId)!;
  assert.equal(row.rejection, "source_rejected");
  assert.equal(row.retryAfter!.getTime(), clock + 86400 * 1000);
  clock += 3600 * 1000;
  assert.deepEqual(await service.resolve(poolId), {
    kind: "missing",
    error: "image_unavailable",
    reason: "source_rejected",
    maxAge: 82800,
  });
  assert.equal(transforms, 0);
});

test("transient failures back off per consecutive attempt, retry when due and heal on success", async () => {
  let clock = 1_000_000_000_000;
  const store = memoryStore({ [poolId]: source });
  let failures = 3;
  const service = createTokenImageService(store, {
    now: () => clock,
    transform: async () => {
      if (failures-- > 0) throw new TokenImageError("fetch_rejected");
      return webp;
    },
  });
  const missing = (reason: string, maxAge: number) => ({
    kind: "missing",
    error: "image_unavailable",
    reason,
    maxAge,
  });
  assert.deepEqual(
    await service.resolve(poolId),
    missing("fetch_rejected", 300),
  );
  assert.equal(store.rows.get(poolId)!.attempts, 1);
  clock += 100 * 1000;
  assert.deepEqual(
    await service.resolve(poolId),
    missing("fetch_rejected", 200),
  );
  assert.equal(failures, 2, "not due yet: no fetch");
  clock += 200 * 1000;
  assert.deepEqual(
    await service.resolve(poolId),
    missing("fetch_rejected", 600),
  );
  assert.equal(store.rows.get(poolId)!.attempts, 2);
  clock += 600 * 1000;
  assert.deepEqual(
    await service.resolve(poolId),
    missing("fetch_rejected", 1200),
  );
  assert.equal(store.rows.get(poolId)!.attempts, 3);
  clock += 1200 * 1000;
  assert.deepEqual(await service.resolve(poolId), {
    kind: "image",
    bytes: webp,
    etag,
  });
  assert.equal(store.rows.get(poolId)!.rejection, null);
  const capped = createTokenImageService(memoryStore({ [poolId]: source }), {
    settings: { ...defaultTokenImageSettings, rejectedSeconds: 1000 },
    transform: async () => {
      throw Error("sharp exploded");
    },
  });
  assert.deepEqual(
    await capped.resolve(poolId),
    missing("decode_rejected", 300),
  );
});

test("a changed catalog image_url re-encodes on the next view", async () => {
  const catalog = { [poolId]: source };
  const store = memoryStore(catalog);
  const sources: string[] = [];
  const service = createTokenImageService(store, {
    transform: async (url) => {
      sources.push(url);
      return Buffer.concat([webp, Buffer.from(url)]);
    },
  });
  const first = await service.resolve(poolId);
  assert.equal(first.kind, "image");
  catalog[poolId] = "https://pools.trade/replacement.png";
  const second = await service.resolve(poolId);
  assert.equal(second.kind, "image");
  assert.notEqual((second as any).etag, (first as any).etag);
  assert.deepEqual(sources, [source, "https://pools.trade/replacement.png"]);
  assert.equal(store.rows.get(poolId)!.sourceUrl, catalog[poolId]);
});

test("the deadline turns a stalled upstream into a short negative entry", async () => {
  const store = memoryStore({ [poolId]: source });
  const service = createTokenImageService(store, {
    settings: { ...defaultTokenImageSettings, deadlineMs: 30 },
    transform: (_source, signal) =>
      new Promise((_, reject) =>
        signal.addEventListener("abort", () =>
          reject(new TokenImageError("timeout")),
        ),
      ),
  });
  const started = Date.now();
  assert.deepEqual(await service.resolve(poolId), {
    kind: "missing",
    error: "image_unavailable",
    reason: "timeout",
    maxAge: 300,
  });
  assert.ok(Date.now() - started < 1000);
  assert.equal(store.rows.get(poolId)!.rejection, "timeout");
});

test("a deadline expiry backs off like any transient failure but caps far below a full day", async () => {
  let clock = 1_000_000_000_000;
  const store = memoryStore({ [poolId]: source });
  const service = createTokenImageService(store, {
    now: () => clock,
    settings: { ...defaultTokenImageSettings, deadlineMs: 20 },
    transform: (_source, signal) =>
      new Promise((_, reject) =>
        signal.addEventListener("abort", () =>
          reject(new TokenImageError("timeout")),
        ),
      ),
  });
  const missing = (maxAge: number) => ({
    kind: "missing",
    error: "image_unavailable",
    reason: "timeout",
    maxAge,
  });
  // 300, 600, 1200, 2400, then capped at timeoutRejectedSeconds (3600) well
  // short of rejectedSeconds (86400), unlike a definitive source rejection.
  for (const maxAge of [300, 600, 1200, 2400, 3600, 3600]) {
    assert.deepEqual(await service.resolve(poolId), missing(maxAge));
    clock += maxAge * 1000;
  }
});

test("a per-request cap bounds one request's slot and queue time tighter than the deadline alone", async () => {
  const store = memoryStore({ [poolId]: source });
  const service = createTokenImageService(store, {
    settings: { ...defaultTokenImageSettings, deadlineMs: 10000, requestCapMs: 40 },
    transform: (_source, signal) =>
      new Promise((_, reject) =>
        signal.addEventListener("abort", () =>
          reject(new TokenImageError("timeout")),
        ),
      ),
  });
  const started = Date.now();
  assert.deepEqual(await service.resolve(poolId), {
    kind: "missing",
    error: "image_unavailable",
    reason: "timeout",
    maxAge: 300,
  });
  assert.ok(
    Date.now() - started < 1000,
    "the 40 ms cap fires long before the 10 s deadline",
  );
});

test("the per-request cap also bounds how long a request waits for a free slot", async () => {
  const otherId = `0x${"b".repeat(64)}`;
  const store = memoryStore({ [poolId]: source, [otherId]: source });
  let releaseHeld: ((bytes: Buffer) => void) | undefined;
  const service = createTokenImageService(store, {
    settings: {
      ...defaultTokenImageSettings,
      deadlineMs: 10000,
      requestCapMs: 40,
      concurrency: 1,
    },
    transform: () => new Promise((resolve) => (releaseHeld = resolve)),
  });
  const held = service.resolve(poolId);
  await new Promise((resolve) => setImmediate(resolve));
  const started = Date.now();
  assert.deepEqual(await service.resolve(otherId), { kind: "busy" });
  assert.ok(
    Date.now() - started < 1000,
    "queueing gives up at the 40 ms cap, not the 10 s deadline",
  );
  releaseHeld!(webp);
  assert.equal((await held).kind, "image");
});

test("fetch slots run in arrival order, the waiting line is bounded and waiters leave after their budget", async () => {
  const ids = Array.from(
    { length: 12 },
    (_, n) => `0x${n.toString(16).padStart(64, "0")}`,
  );
  const store = memoryStore(Object.fromEntries(ids.map((id) => [id, source])));
  const finish: ((bytes: Buffer) => void)[] = [];
  const service = createTokenImageService(store, {
    settings: {
      ...defaultTokenImageSettings,
      deadlineMs: 5000,
      concurrency: 2,
    },
    transform: () => new Promise((resolve) => finish.push(resolve)),
  });
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const outcomes = ids.map((id) => service.resolve(id));
  await tick();
  assert.equal(finish.length, 2, "two fetches run at once");
  // Ten more arrived: eight wait in line, the last two are refused at once.
  assert.deepEqual(
    (await Promise.all(outcomes.slice(10))).map((o) => o.kind),
    ["busy", "busy"],
  );
  for (let served = 2; served <= 10; served += 2) {
    finish.splice(0, 2).forEach((resolve) => resolve(webp));
    await tick();
    assert.equal(finish.length, Math.min(2, 10 - served));
  }
  const settled = await Promise.all(outcomes.slice(0, 10));
  assert.ok(settled.every((o) => o.kind === "image"));
  assert.equal(store.rows.size, 10);
  const stalled = createTokenImageService(
    memoryStore({ [poolId]: source, [ids[1]]: source }),
    {
      settings: {
        ...defaultTokenImageSettings,
        deadlineMs: 30,
        concurrency: 1,
      },
      transform: () => new Promise((resolve) => finish.push(resolve)),
    },
  );
  const held = stalled.resolve(poolId);
  assert.deepEqual(await stalled.resolve(ids[1]), { kind: "busy" });
  finish.pop()!(webp);
  assert.equal((await held).kind, "image");
});

test("a failed store write still serves the encoded image and never leaks details", async () => {
  const store = memoryStore({ [poolId]: source });
  store.failSave = true;
  const lines: string[] = [];
  const write = process.stderr.write;
  process.stderr.write = ((chunk: string) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const service = createTokenImageService(store, {
      transform: async () => webp,
    });
    assert.deepEqual(await service.resolve(poolId), {
      kind: "image",
      bytes: webp,
      etag,
    });
  } finally {
    process.stderr.write = write;
  }
  assert.deepEqual(lines, ['{"event":"token_image_store_failed"}\n']);
});

test("HTTP serves WebP with a strong ETag, honours If-None-Match, HEAD and cacheable 404s", async (t) => {
  const store = memoryStore({
    [poolId]: source,
    [`0x${"c".repeat(64)}`]: "ipfs://not-a-cid",
  });
  const images = createTokenImageService(store, {
    transform: async () => webp,
  });
  let now = 0;
  const server = createApi(
    {
      async read() {
        return { items: [] };
      },
      async close() {},
    },
    { now: () => now, maxPerMinute: 1, maxImagesPerMinute: 9, images },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/v1/pools/${poolId}/image`;
  const first = await fetch(url);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("content-type"), "image/webp");
  assert.equal(first.headers.get("etag"), etag);
  assert.equal(first.headers.get("content-length"), String(webp.length));
  assert.equal(
    first.headers.get("cache-control"),
    "public, max-age=86400, s-maxage=2592000, stale-while-revalidate=604800",
  );
  assert.equal(first.headers.get("x-content-type-options"), "nosniff");
  assert.equal(
    first.headers.get("content-security-policy"),
    "default-src 'none'; sandbox",
  );
  assert.deepEqual(Buffer.from(await first.arrayBuffer()), webp);
  const head = await fetch(url, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("etag"), etag);
  assert.equal(head.headers.get("content-length"), String(webp.length));
  assert.equal(await head.text(), "");
  for (const value of [etag, `W/${etag}`, `"other", ${etag}`, "*"]) {
    const revalidated = await fetch(url, {
      headers: { "If-None-Match": value },
    });
    assert.equal(revalidated.status, 304, value);
    assert.equal(revalidated.headers.get("etag"), etag);
    assert.match(revalidated.headers.get("cache-control")!, /s-maxage/);
    assert.equal(await revalidated.text(), "");
  }
  assert.equal(
    (await fetch(url, { headers: { "If-None-Match": '"stale"' } })).status,
    200,
  );
  const query = await fetch(`${url}?url=http://127.0.0.1/`);
  assert.equal(query.status, 400);
  assert.deepEqual(await query.json(), { error: "invalid_parameter" });
  const rejected = await fetch(
    `http://127.0.0.1:${address.port}/v1/pools/0x${"c".repeat(64)}/image`,
  );
  assert.equal(rejected.status, 404);
  assert.equal(
    rejected.headers.get("cache-control"),
    "public, max-age=86400, s-maxage=86400",
  );
  assert.deepEqual(await rejected.json(), {
    error: "image_unavailable",
    reason: "source_rejected",
  });
  const unknown = await fetch(
    `http://127.0.0.1:${address.port}/v1/pools/0x${"d".repeat(64)}/image`,
  );
  assert.equal(unknown.status, 404);
  assert.equal(
    unknown.headers.get("cache-control"),
    "public, max-age=300, s-maxage=300",
  );
  assert.deepEqual(await unknown.json(), { error: "pool_not_indexed" });
  assert.equal((await fetch(url, { method: "POST" })).status, 405);
  // Images spend their own budget: the single JSON read is still available.
  assert.equal(
    (await fetch(`http://127.0.0.1:${address.port}/v1/pools`)).status,
    200,
  );
  const limited = await fetch(url);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "60");
  now = 61000;
  assert.equal((await fetch(url)).status, 200);
  const without = createApi({
    async read() {
      return {};
    },
    async close() {},
  });
  without.listen(0, "127.0.0.1");
  await once(without, "listening");
  t.after(() => new Promise<void>((resolve) => without.close(() => resolve())));
  const port = (without.address() as { port: number }).port;
  assert.equal(
    (await fetch(`http://127.0.0.1:${port}/v1/pools/${poolId}/image`)).status,
    404,
  );
});
