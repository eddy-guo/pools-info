import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  createTokenImageHandler,
  imageLifetimes,
  imageProxy,
  resolveStoredImage,
  type StoredImageResult,
  type StoredImageView,
} from "./token-image";

const poolId = `0x${"a".repeat(64)}`;
const etag = `"${"9".repeat(64)}"`;
const icon = new Uint8Array(
  Buffer.from("UklGRhIAAABXRUJQVlA4TAYAAAAvAAAAEAA=", "base64"),
);
// What the merged store actually sends, per "Token icon store" in apps/api/README.md.
const storeCacheControl =
  "public, max-age=86400, s-maxage=2592000, stale-while-revalidate=604800";
const served = (
  browser = 86400,
  edge = 2592000,
  staleWhileRevalidate = 604800,
) =>
  `public, max-age=${browser}, s-maxage=${edge}, stale-while-revalidate=${staleWhileRevalidate}`;
const negative = (seconds: number) =>
  `public, max-age=${seconds}, s-maxage=${seconds}`;

const request = (query = "", headers: HeadersInit = {}, method = "GET") =>
  new Request(`https://poolsinfo.com/api/token-image/${poolId}/${query}`, {
    method,
    headers,
  });
const stored: StoredImageResult = {
  state: "stored",
  etag,
  bytes: icon,
  length: icon.byteLength,
  lifetimes: { browser: 86400, edge: 2592000, staleWhileRevalidate: 604800 },
};

/** Records the store reads a handler performs, answering each with `result`. */
function store(result: StoredImageResult | (() => Promise<never>)) {
  const views: { poolId: string; view: StoredImageView }[] = [];
  const source = async (
    id: string,
    view: StoredImageView,
    signal: AbortSignal,
  ) => {
    views.push({ poolId: id, view });
    assert.equal(signal.aborted, false);
    return typeof result === "function" ? await result() : result;
  };
  return { views, source };
}

/** Replaces global fetch with one canned store response and records the call. */
function storeTransport(
  t: TestContext,
  response: () => Response | Promise<Response>,
) {
  const calls: { url: URL; init: RequestInit }[] = [];
  t.mock.method(globalThis, "fetch", async (url: URL, init: RequestInit) => {
    calls.push({ url, init });
    return await response();
  });
  const previous = process.env.INDEXER_API_URL,
    disabled = process.env.CHAIN_REFRESH_DISABLED;
  process.env.INDEXER_API_URL = "https://api.example.com";
  delete process.env.CHAIN_REFRESH_DISABLED;
  t.after(() => {
    if (previous === undefined) delete process.env.INDEXER_API_URL;
    else process.env.INDEXER_API_URL = previous;
    if (disabled === undefined) delete process.env.CHAIN_REFRESH_DISABLED;
    else process.env.CHAIN_REFRESH_DISABLED = disabled;
  });
  return calls;
}
const view: StoredImageView = { method: "GET", ifNoneMatch: null };

test("the route validates its own input before any store read", async () => {
  const { views, source } = store(stored);
  const handler = createTokenImageHandler(source);
  for (const [name, id, query] of [
    ["a URL override", poolId, "?url=http://127.0.0.1/"],
    ["any query string at all", poolId, "?v=2"],
    ["a foreign origin as the pool id", "https://elsewhere.example", ""],
    ["a short pool id", `0x${"a".repeat(63)}`, ""],
    ["a wallet address", `0x${"a".repeat(40)}`, ""],
    ["path traversal", "../../secret", ""],
  ] as const) {
    const refused = await handler(request(query), id);
    assert.equal(refused.status, 400, name);
    assert.equal(
      refused.headers.get("cache-control"),
      negative(imageLifetimes.invalid),
      name,
    );
    assert.equal((await refused.arrayBuffer()).byteLength, 0, name);
  }
  assert.deepEqual(views, []);
  assert.ok(imageLifetimes.invalid >= 86400);
});

test("a stored icon is served with the store's validator, type, length and lifetimes", async () => {
  const { views, source } = store(stored);
  const handler = createTokenImageHandler(source);
  const response = await handler(request(), poolId.toUpperCase());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/webp");
  assert.equal(response.headers.get("etag"), etag);
  assert.equal(response.headers.get("content-length"), String(icon.byteLength));
  assert.equal(response.headers.get("cache-control"), served());
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(
    response.headers.get("content-security-policy"),
    "default-src 'none'; sandbox",
  );
  assert.equal(response.headers.get("set-cookie"), null);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), icon);
  // One view is one store read, for the normalised pool id, and nothing else.
  assert.deepEqual(views, [{ poolId, view }]);
});

test("the client's validator is relayed and the store's 304 answered as a 304", async () => {
  const unchanged: StoredImageResult = {
    state: "unchanged",
    etag,
    lifetimes: stored.lifetimes,
  };
  const { views, source } = store(unchanged);
  const handler = createTokenImageHandler(source);
  for (const header of [etag, `W/${etag}`, `"stale", ${etag}`, "*"]) {
    const response = await handler(
      request("", { "if-none-match": header }),
      poolId,
    );
    assert.equal(response.status, 304, header);
    assert.equal(response.headers.get("etag"), etag, header);
    assert.equal(response.headers.get("cache-control"), served(), header);
    assert.equal((await response.arrayBuffer()).byteLength, 0, header);
  }
  assert.deepEqual(
    views.map((v) => v.view.ifNoneMatch),
    [etag, `W/${etag}`, `"stale", ${etag}`, "*"],
  );
  // A validator no store could usefully compare is dropped, not relayed.
  for (const unusable of [`"${"a".repeat(1024)}"`, "\u0080obs-text"]) {
    await handler(request("", { "if-none-match": unusable }), poolId);
    assert.equal(views.at(-1)!.view.ifNoneMatch, null);
  }
});

test("a HEAD view asks the store for headers only and returns no bytes", async () => {
  const { views, source } = store({ ...stored, bytes: null });
  const handler = createTokenImageHandler(source);
  const response = await handler(request("", {}, "HEAD"), poolId);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("etag"), etag);
  assert.equal(response.headers.get("content-type"), "image/webp");
  assert.equal(response.headers.get("cache-control"), served());
  assert.equal((await response.arrayBuffer()).byteLength, 0);
  assert.deepEqual(
    views.map((v) => v.view.method),
    ["HEAD"],
  );
});

test("each 404 reason keeps exactly the negative lifetime the store states", async () => {
  // The store's own lifetimes: pool_not_indexed and transient failures are
  // short, policy rejections last a day. The website shows its generated icon
  // for all of them, so only the lifetime has to travel.
  for (const seconds of [300, 600, 86400, imageLifetimes.maxSeconds]) {
    const { views, source } = store({ state: "absent", seconds });
    const handler = createTokenImageHandler(source);
    const response = await handler(request(), poolId);
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("cache-control"), negative(seconds));
    assert.equal(response.headers.get("etag"), null);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal((await response.arrayBuffer()).byteLength, 0);
    assert.equal(views.length, 1);
  }
});

test("a busy, rate-limited or unreachable store is transient and caches nothing", async () => {
  for (const retryAfter of [imageLifetimes.retryAfter, 30]) {
    const handler = createTokenImageHandler(
      store({ state: "busy", retryAfter }).source,
    );
    const response = await handler(request(), poolId);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("retry-after"), String(retryAfter));
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal((await response.arrayBuffer()).byteLength, 0);
  }
  const thrown = createTokenImageHandler(
    store(async () => {
      throw new Error("the store seam failed unexpectedly");
    }).source,
  );
  const response = await thrown(request(), poolId);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), "5");
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("a stalled store read ends at the route's deadline, not the platform's", async () => {
  let aborted = false;
  const handler = createTokenImageHandler(
    async (_poolId, _view, signal) =>
      await new Promise<StoredImageResult>((resolve) =>
        signal.addEventListener("abort", () => {
          aborted = true;
          resolve({ state: "busy", retryAfter: imageLifetimes.retryAfter });
        }),
      ),
    20,
  );
  const started = Date.now();
  const response = await handler(request(), poolId);
  assert.equal(response.status, 503);
  assert.ok(aborted);
  assert.ok(Date.now() - started < 1000);
  // The store caps one request at 12 s; ours must exceed that so a first view
  // gets the store's answer, and still finish inside the route's 15 s limit.
  assert.ok(imageProxy.timeoutMs > 12000 && imageProxy.timeoutMs < 15000);
});

test("the store read targets the documented endpoint and forwards no client state", async (t) => {
  const calls = storeTransport(
    t,
    () =>
      new Response(icon, {
        headers: {
          "content-type": "image/webp",
          "content-length": String(icon.byteLength),
          "cache-control": storeCacheControl,
          etag,
          "set-cookie": "untrusted=never-forward",
        },
      }),
  );
  const result = await resolveStoredImage(
    poolId,
    { method: "GET", ifNoneMatch: etag },
    AbortSignal.timeout(1000),
  );
  assert.equal(result.state, "stored");
  assert.ok(result.state === "stored");
  assert.equal(result.etag, etag);
  assert.equal(result.length, icon.byteLength);
  assert.deepEqual(result.bytes, icon);
  assert.deepEqual(result.lifetimes, {
    browser: 86400,
    edge: 2592000,
    staleWhileRevalidate: 604800,
  });
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url.href,
    `https://api.example.com/v1/pools/${poolId}/image`,
  );
  assert.equal(calls[0].url.search, "");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(calls[0].init.cache, "no-store");
  assert.deepEqual(calls[0].init.headers, {
    Accept: "image/webp",
    "If-None-Match": etag,
  });
});

test("the store's own statuses map onto the proxy's response classes", async (t) => {
  for (const [name, build, expected] of [
    [
      "304 on a matching validator",
      () => new Response(null, { status: 304, headers: { etag } }),
      { state: "unchanged", etag },
    ],
    [
      "pool_not_indexed",
      () =>
        Response.json(
          { error: "pool_not_indexed" },
          { status: 404, headers: { "cache-control": negative(300) } },
        ),
      { state: "absent", seconds: 300 },
    ],
    [
      "source_rejected",
      () =>
        Response.json(
          { error: "image_unavailable", reason: "source_rejected" },
          { status: 404, headers: { "cache-control": negative(86400) } },
        ),
      { state: "absent", seconds: 86400 },
    ],
    [
      "a 404 that states no lifetime",
      () => new Response(null, { status: 404 }),
      { state: "absent", seconds: imageLifetimes.absent },
    ],
    [
      "busy with Retry-After",
      () =>
        Response.json(
          { error: "busy" },
          { status: 503, headers: { "retry-after": "5" } },
        ),
      { state: "busy", retryAfter: 5 },
    ],
    [
      "the request budget",
      () =>
        new Response(null, { status: 429, headers: { "retry-after": "42" } }),
      { state: "busy", retryAfter: 42 },
    ],
    [
      "an unusable Retry-After",
      () =>
        new Response(null, { status: 503, headers: { "retry-after": "soon" } }),
      { state: "busy", retryAfter: imageLifetimes.retryAfter },
    ],
    [
      "an unexpected status",
      () => new Response("gateway", { status: 502 }),
      { state: "busy", retryAfter: imageLifetimes.retryAfter },
    ],
  ] as const) {
    await t.test(name, async (sub) => {
      storeTransport(sub, build);
      assert.deepEqual(
        await resolveStoredImage(poolId, view, AbortSignal.timeout(1000)),
        expected.state === "unchanged"
          ? {
              ...expected,
              lifetimes: {
                browser: imageLifetimes.browser,
                edge: imageLifetimes.edge,
                staleWhileRevalidate: imageLifetimes.staleWhileRevalidate,
              },
            }
          : expected,
      );
    });
  }
});

test("a store response that is not a bounded WebP body is never passed to the browser", async (t) => {
  for (const [name, build] of [
    [
      "a mislabelled HTML body",
      () =>
        new Response("<html></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    ],
    [
      "an SVG claiming to be an image",
      () =>
        new Response('<svg xmlns="http://www.w3.org/2000/svg"/>', {
          status: 200,
          headers: { "content-type": "image/svg+xml" },
        }),
    ],
    [
      "a body larger than the advertised length",
      () =>
        new Response(icon, {
          status: 200,
          headers: {
            "content-type": "image/webp",
            "content-length": String(icon.byteLength - 1),
          },
        }),
    ],
    [
      "an advertised length above the cap",
      () =>
        new Response(icon, {
          status: 200,
          headers: {
            "content-type": "image/webp",
            "content-length": String(imageProxy.maxBytes + 1),
          },
        }),
    ],
    [
      "an unparsable length",
      () =>
        new Response(icon, {
          status: 200,
          headers: { "content-type": "image/webp", "content-length": "NaN" },
        }),
    ],
    [
      "an empty body",
      () =>
        new Response(null, {
          status: 200,
          headers: { "content-type": "image/webp" },
        }),
    ],
    [
      "a body over the cap",
      () =>
        new Response(new Uint8Array(imageProxy.maxBytes + 1), {
          status: 200,
          headers: { "content-type": "image/webp" },
        }),
    ],
    [
      "an unreachable store",
      () => {
        throw new Error("ECONNRESET");
      },
    ],
  ] as const) {
    await t.test(name, async (sub) => {
      storeTransport(sub, build);
      assert.deepEqual(
        await resolveStoredImage(poolId, view, AbortSignal.timeout(1000)),
        { state: "busy", retryAfter: imageLifetimes.retryAfter },
      );
    });
  }
});

test("a validator the store did not send strongly is not invented or relayed", async (t) => {
  for (const weak of ['W/"abc"', "abc", '"withobs"', ""]) {
    await t.test(JSON.stringify(weak), async (sub) => {
      storeTransport(
        sub,
        () =>
          new Response(icon, {
            status: 200,
            headers: { "content-type": "image/webp", etag: weak },
          }),
      );
      const result = await resolveStoredImage(
        poolId,
        view,
        AbortSignal.timeout(1000),
      );
      assert.ok(result.state === "stored");
      assert.equal(result.etag, null);
      const response = await createTokenImageHandler(async () => result)(
        request(),
        poolId,
      );
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("etag"), null);
    });
  }
});

test("a HEAD store read transfers no body and still reports the stored length", async (t) => {
  const calls = storeTransport(
    t,
    () =>
      new Response(null, {
        status: 200,
        headers: {
          "content-type": "image/webp",
          "content-length": String(icon.byteLength),
          "cache-control": storeCacheControl,
          etag,
        },
      }),
  );
  const result = await resolveStoredImage(
    poolId,
    { method: "HEAD", ifNoneMatch: null },
    AbortSignal.timeout(1000),
  );
  assert.deepEqual(result, {
    state: "stored",
    etag,
    bytes: null,
    length: icon.byteLength,
    lifetimes: {
      browser: 86400,
      edge: 2592000,
      staleWhileRevalidate: 604800,
    },
  });
  assert.equal(calls[0].init.method, "HEAD");
  assert.deepEqual(calls[0].init.headers, { Accept: "image/webp" });
});

test("lifetimes the store states replace the fallbacks, and only sane ones", async (t) => {
  for (const [header, lifetimes] of [
    [
      "public, max-age=60, s-maxage=120, stale-while-revalidate=180",
      { browser: 60, edge: 120, staleWhileRevalidate: 180 },
    ],
    [
      // Unstated directives fall back; s-maxage is not read as max-age.
      "public, s-maxage=120",
      {
        browser: imageLifetimes.browser,
        edge: 120,
        staleWhileRevalidate: imageLifetimes.staleWhileRevalidate,
      },
    ],
    [
      "public, max-age=99999999999, s-maxage=-5, stale-while-revalidate=zzz",
      {
        browser: imageLifetimes.maxSeconds,
        edge: imageLifetimes.edge,
        staleWhileRevalidate: imageLifetimes.staleWhileRevalidate,
      },
    ],
  ] as const) {
    await t.test(header, async (sub) => {
      storeTransport(
        sub,
        () =>
          new Response(icon, {
            status: 200,
            headers: { "content-type": "image/webp", "cache-control": header },
          }),
      );
      const result = await resolveStoredImage(
        poolId,
        view,
        AbortSignal.timeout(1000),
      );
      assert.ok(result.state === "stored");
      assert.deepEqual(result.lifetimes, lifetimes);
      const response = await createTokenImageHandler(async () => result)(
        request(),
        poolId,
      );
      assert.equal(
        response.headers.get("cache-control"),
        served(
          lifetimes.browser,
          lifetimes.edge,
          lifetimes.staleWhileRevalidate,
        ),
      );
    });
  }
});

test("without a usable read API base nothing is fetched and the icon is simply absent", async (t) => {
  const previous = process.env.INDEXER_API_URL,
    disabled = process.env.CHAIN_REFRESH_DISABLED;
  t.after(() => {
    if (previous === undefined) delete process.env.INDEXER_API_URL;
    else process.env.INDEXER_API_URL = previous;
    if (disabled === undefined) delete process.env.CHAIN_REFRESH_DISABLED;
    else process.env.CHAIN_REFRESH_DISABLED = disabled;
  });
  let fetches = 0;
  t.mock.method(globalThis, "fetch", async () => {
    fetches++;
    return new Response(null, { status: 200 });
  });
  for (const [base, refreshDisabled] of [
    [undefined, undefined],
    ["https://api.example.com", "1"],
    ["not-a-url", undefined],
    ["file:///etc/passwd", undefined],
    ["https://user:pass@api.example.com", undefined],
    ["https://api.example.com/nested/base", undefined],
    ["https://api.example.com/?token=secret", undefined],
    ["https://api.example.com/#fragment", undefined],
  ] as const) {
    if (base === undefined) delete process.env.INDEXER_API_URL;
    else process.env.INDEXER_API_URL = base;
    if (refreshDisabled === undefined)
      delete process.env.CHAIN_REFRESH_DISABLED;
    else process.env.CHAIN_REFRESH_DISABLED = refreshDisabled;
    assert.deepEqual(
      await resolveStoredImage(poolId, view, AbortSignal.timeout(1000)),
      { state: "absent", seconds: imageLifetimes.absent },
      String(base),
    );
  }
  assert.equal(fetches, 0);
  // A pool with no icon yet is the store's shortest retry, not a day-long miss.
  assert.equal(imageLifetimes.absent, 300);
});
