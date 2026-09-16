import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import https from "node:https";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { IncomingMessage, ClientRequest } from "node:http";
import type { LookupFunction } from "node:net";
import sharp from "sharp";
import {
  createTokenImageHandler,
  ImageRejection,
  imageLifetimes,
  imagePolicy,
  indexedImageUrl,
  publicImageAddress,
  tokenImageUrl,
  transformedTokenImage,
} from "./token-image";

const poolId = `0x${"a".repeat(64)}`;
const cid = "bafkreibxargr7pdwdydhztyg2dbbkm4oueutbsfjcwcp24zrhlyem55iru";
const source = "https://pools.trade/icon.png";
const resolvePublic = async () => [{ address: "93.184.216.34", family: 4 }];
const request = (query = "", headers: HeadersInit = {}) =>
  new Request(`https://poolsinfo.com/api/token-image/${poolId}/${query}`, {
    headers,
  });
const rejection = (permanent: boolean) => (error: unknown) =>
  error instanceof ImageRejection && error.permanent === permanent;
const served = `public, max-age=${imageLifetimes.browser}, s-maxage=${imageLifetimes.edge}, stale-while-revalidate=${imageLifetimes.staleWhileRevalidate}`;
const negative = (seconds: number) =>
  `public, max-age=${seconds}, s-maxage=${seconds}`;

function transport(
  t: TestContext,
  options: {
    bytes?: Buffer;
    mime?: string;
    status?: number;
    contentLength?: string;
    encoding?: string;
    stall?: boolean;
    unreachable?: boolean;
  } = {},
) {
  const calls: { url: URL; options: https.RequestOptions }[] = [];
  const destroyed: string[] = [];
  t.mock.method(
    https,
    "request",
    (
      url: URL,
      config: https.RequestOptions,
      callback: (response: IncomingMessage) => void,
    ) => {
      calls.push({ url, options: config });
      const req = new EventEmitter() as ClientRequest;
      req.destroy = () => {
        destroyed.push("request");
        return req;
      };
      req.end = (() => {
        queueMicrotask(() => {
          if (options.unreachable) {
            req.emit("error", new Error("ECONNRESET"));
            return;
          }
          const stream = new PassThrough();
          const res = stream as unknown as IncomingMessage;
          res.statusCode = options.status ?? 200;
          res.headers = {
            "content-type": options.mime ?? "image/png",
            ...(options.contentLength === undefined
              ? {}
              : { "content-length": options.contentLength }),
            ...(options.encoding
              ? { "content-encoding": options.encoding }
              : {}),
            "set-cookie": ["untrusted=never-forward"],
            location: "http://127.0.0.1/secret",
          };
          callback(res);
          if (!options.stall && !res.destroyed)
            stream.end(options.bytes ?? Buffer.alloc(0));
        });
        return req;
      }) as ClientRequest["end"];
      return req;
    },
  );
  return { calls, destroyed };
}

test("image URL policy accepts HTTPS/IPFS only and blocks local/special address spellings", () => {
  assert.equal(
    tokenImageUrl(`ipfs://${cid}`).href,
    `${imagePolicy.ipfsGateway}/ipfs/${cid}`,
  );
  assert.equal(
    tokenImageUrl(`ipfs://${cid}/icon.png`).pathname,
    `/ipfs/${cid}/icon.png`,
  );
  assert.equal(tokenImageUrl(source).href, source);
  assert.throws(() =>
    tokenImageUrl("https://unreviewed-public-host.com/icon.png"),
  );
  for (const value of [
    "http://images.example.com/a",
    "file:///etc/passwd",
    "data:image/png,a",
    "https://user:pass@images.example.com/a",
    "https://images.example.com:8443/a",
    "https://localhost/a",
    "https://metadata.google.internal/a",
    "https://127.1/a",
    "https://2130706433/a",
    "https://0x7f000001/a",
    "https://[::ffff:127.0.0.1]/a",
    "https://[::]/a",
    "https://images.example.com/a\r\nb",
    "https://images.example.com./a",
    `ipfs://${cid}/%2e%2e/admin`,
    `ipfs://${cid}/a%2fb`,
    `ipfs://${cid}?url=private`,
    "ipns://some-name/a",
    `https://images.example.com/${"a".repeat(2048)}`,
  ])
    assert.throws(() => tokenImageUrl(value), Error, value);
  for (const value of [
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.1.1",
    "192.0.0.9",
    "192.0.2.1",
    "192.168.1.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "::ffff:8.8.8.8",
    "::ffff:192.168.1.1",
    "64:ff9b::808:808",
    "fe80::1",
    "fe80::1%en0",
    "fc00::1",
    "fdff::1",
    "ff02::1",
    "2001:db8::1",
    "2002:0808:0808::1",
    "2001::1",
    "3fff::1",
    "3ffe::1",
    "not-an-ip",
  ])
    assert.equal(publicImageAddress(value), false, value);
  for (const value of [
    "8.8.8.8",
    "93.184.216.34",
    "2606:4700:4700::1111",
    "2001:4860:4860::8888",
  ])
    assert.equal(publicImageAddress(value), true, value);
});

test("fetch boundary pins the validated DNS answer, preserves TLS hostname and re-encodes real raster bytes", async (t) => {
  const input = await sharp({
    create: { width: 320, height: 240, channels: 3, background: "red" },
  })
    .withMetadata()
    .png()
    .toBuffer();
  const stub = transport(t, {
    bytes: input,
    contentLength: String(input.length),
  });
  let resolutions = 0;
  const image = await transformedTokenImage(
    source,
    AbortSignal.timeout(1000),
    async () => {
      resolutions++;
      return resolutions === 1
        ? await resolvePublic()
        : [{ address: "127.0.0.1", family: 4 }];
    },
  );
  assert.equal(resolutions, 1);
  assert.equal(stub.calls[0].url.hostname, "pools.trade");
  assert.equal(stub.calls[0].options.agent, false);
  assert.equal(stub.calls[0].options.rejectUnauthorized, true);
  const pinned = stub.calls[0].options.lookup as LookupFunction;
  pinned("pools.trade", { all: false }, (error, address, family) => {
    assert.equal(error, null);
    assert.equal(address, "93.184.216.34");
    assert.equal(family, 4);
  });
  pinned("pools.trade", { all: true }, (error, addresses) => {
    assert.equal(error, null);
    assert.deepEqual(addresses, [{ address: "93.184.216.34", family: 4 }]);
  });
  const decoded = await sharp(image).metadata();
  assert.equal(decoded.format, "webp");
  assert.equal(decoded.width, 128);
  assert.equal(decoded.height, 128);
  assert.equal(decoded.exif, undefined);
  assert.equal(decoded.icc, undefined);
  assert.notDeepEqual(image, input);
});

test("mixed/private DNS answers fail before opening an HTTPS connection", async (t) => {
  const stub = transport(t);
  for (const values of [
    [],
    [{ address: "127.0.0.1", family: 4 }],
    [
      { address: "93.184.216.34", family: 4 },
      { address: "fc00::1", family: 6 },
    ],
    [{ address: "::ffff:93.184.216.34", family: 6 }],
    [{ address: "93.184.216.34", family: 6 }],
  ])
    await assert.rejects(
      transformedTokenImage(
        source,
        AbortSignal.timeout(1000),
        async () => values,
      ),
    );
  assert.equal(stub.calls.length, 0);
});

test("redirects, encoded/oversized bodies and MIME confusion are rejected at the request boundary", async (t) => {
  const png = await sharp({
    create: { width: 2, height: 2, channels: 3, background: "blue" },
  })
    .png()
    .toBuffer();
  // A status other than 200 may pass; what a 200 serves is the host's answer.
  for (const options of [
    { status: 302, bytes: png, permanent: false },
    { status: 503, bytes: png, permanent: false },
    { unreachable: true, bytes: png, permanent: false },
    { contentLength: String(imagePolicy.maxBytes + 1), bytes: png },
    { contentLength: "NaN", bytes: png },
    { bytes: Buffer.alloc(imagePolicy.maxBytes + 1) },
    { encoding: "gzip", bytes: png },
    { mime: "text/html", bytes: Buffer.from("<html></html>") },
    { mime: "image/svg+xml", bytes: Buffer.from("<svg></svg>") },
    {
      mime: "image/png",
      bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
    },
    { mime: "image/jpeg", bytes: png },
    { bytes: png.subarray(0, 16) },
  ]) {
    await t.test(
      JSON.stringify({ ...options, bytes: options.bytes.length }),
      async (sub) => {
        const stub = transport(sub, options);
        await assert.rejects(
          transformedTokenImage(
            source,
            AbortSignal.timeout(1000),
            resolvePublic,
          ),
          rejection(options.permanent ?? true),
        );
        assert.equal(
          stub.calls.length,
          1,
          "redirect must not open a second connection",
        );
      },
    );
  }
  await t.test("compressed raster pixel bomb", async (sub) => {
    const oversized = await sharp({
      create: { width: 2200, height: 2200, channels: 3, background: "white" },
    })
      .png()
      .toBuffer();
    assert.ok(oversized.length < imagePolicy.maxBytes);
    transport(sub, { bytes: oversized });
    await assert.rejects(
      transformedTokenImage(source, AbortSignal.timeout(1000), resolvePublic),
      (error: unknown) =>
        rejection(true)(error) &&
        /pixel limit/u.test(String((error as ImageRejection).cause)),
    );
  });
});

test("endpoint obtains metadata by exact pool identity, never forwards client URL/cookies and caches output", async (t) => {
  const png = await sharp({
    create: { width: 2, height: 2, channels: 3, background: "blue" },
  })
    .png()
    .toBuffer();
  const stub = transport(t, { bytes: png });
  let reads = 0;
  const handler = createTokenImageHandler(async (id) => {
    reads++;
    assert.equal(id, poolId);
    return source;
  }, resolvePublic);
  const invalid = await handler(request("?url=http://127.0.0.1/"), poolId);
  assert.equal(invalid.status, 400);
  assert.equal(
    invalid.headers.get("cache-control"),
    negative(imageLifetimes.rejected),
  );
  assert.equal(
    (await handler(request(), "https://elsewhere.example")).status,
    400,
  );
  assert.equal(reads, 0);
  assert.equal(stub.calls.length, 0);
  const [first, second] = await Promise.all([
    handler(request(), poolId),
    handler(request(), poolId),
  ]);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(first.headers.get("content-type"), "image/webp");
  assert.equal(first.headers.get("set-cookie"), null);
  assert.equal(first.headers.get("x-content-type-options"), "nosniff");
  assert.equal(first.headers.get("cache-control"), served);
  assert.ok(imageLifetimes.browser >= 86400);
  assert.ok(imageLifetimes.edge >= 604800);
  assert.ok(imageLifetimes.staleWhileRevalidate >= 604800);
  const etag = first.headers.get("etag")!;
  assert.equal(
    etag,
    `"${createHash("sha256")
      .update(Buffer.from(await first.arrayBuffer()))
      .digest("hex")}"`,
  );
  assert.equal(second.headers.get("etag"), etag);
  assert.equal((await handler(request(), poolId)).status, 200);
  for (const header of [etag, `W/${etag}`, `"stale", ${etag}`, "*"]) {
    const unchanged = await handler(
      request("", { "if-none-match": header }),
      poolId,
    );
    assert.equal(unchanged.status, 304, header);
    assert.equal(unchanged.headers.get("etag"), etag);
    assert.equal(unchanged.headers.get("cache-control"), served);
    assert.equal((await unchanged.arrayBuffer()).byteLength, 0);
  }
  const changed = await handler(
    request("", { "if-none-match": '"someone-elses-bytes"' }),
    poolId,
  );
  assert.equal(changed.status, 200);
  assert.equal(changed.headers.get("etag"), etag);
  assert.equal(reads, 1);
  assert.equal(stub.calls.length, 1);
  assert.deepEqual(Object.keys(stub.calls[0].options.headers!), [
    "Accept",
    "Accept-Encoding",
  ]);
});

test("whole operation timeout covers metadata and DNS stalls, with bounded negative caching", async () => {
  for (const stage of ["metadata", "dns"]) {
    let reads = 0;
    const handler = createTokenImageHandler(
      async () => {
        reads++;
        return stage === "metadata"
          ? await new Promise<string>(() => {})
          : source;
      },
      async () => new Promise(() => {}),
      20,
    );
    const started = Date.now();
    const timedOut = await handler(request(), poolId);
    assert.equal(timedOut.status, 404);
    assert.equal(
      timedOut.headers.get("cache-control"),
      negative(imageLifetimes.unavailable),
    );
    assert.ok(Date.now() - started < 1000);
    assert.equal((await handler(request(), poolId)).status, 404);
    assert.equal(reads, 1);
  }
});

test("permanent rejections and transient failures keep separate negative caches", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const html = { mime: "text/html", bytes: Buffer.from("<html></html>") };
  for (const [name, imageUrl, permanent, options] of [
    [
      "host outside the allowlist",
      "https://unreviewed-public-host.com/i.png",
      true,
      {},
    ],
    ["invalid image URL", "ipfs://not-a-cid", true, {}],
    ["no image URL on record", null, true, {}],
    ["upstream 200 that is not a usable image", source, true, html],
    ["upstream 503", source, false, { status: 503 }],
    ["upstream network error", source, false, { unreachable: true }],
  ] as const) {
    await t.test(name, async (sub) => {
      const stub = transport(sub, options);
      let reads = 0;
      const handler = createTokenImageHandler(async () => {
        reads++;
        return imageUrl;
      }, resolvePublic);
      const seconds = permanent
        ? imageLifetimes.rejected
        : imageLifetimes.unavailable;
      const missing = await handler(request(), poolId);
      assert.equal(missing.status, 404);
      assert.equal(missing.headers.get("cache-control"), negative(seconds));
      assert.equal(missing.headers.get("etag"), null);
      assert.equal((await missing.arrayBuffer()).byteLength, 0);
      // The fallback stays cheap: the client's 5 s and 10 s retries and a
      // whole day of repeats never reach the origin for a permanent rejection.
      t.mock.timers.tick((seconds - 1) * 1000);
      const repeated = await handler(request(), poolId);
      assert.equal(repeated.status, 404);
      assert.equal(repeated.headers.get("cache-control"), negative(seconds));
      assert.equal(reads, 1);
      assert.ok(stub.calls.length <= 1);
      t.mock.timers.tick(2000);
      assert.equal((await handler(request(), poolId)).status, 404);
      assert.equal(reads, 2);
    });
  }
  assert.ok(imageLifetimes.rejected >= 86400);
});

test("a stored image is served through the same response path before any lookup", async (t) => {
  const stub = transport(t);
  const stored = await sharp({
    create: { width: 128, height: 128, channels: 3, background: "green" },
  })
    .webp()
    .toBuffer();
  const lookups: string[] = [];
  const handler = createTokenImageHandler(
    async () => assert.fail("the live lookup must not run after a store hit"),
    resolvePublic,
    imagePolicy.timeoutMs,
    async (id, signal) => {
      lookups.push(id);
      assert.equal(signal.aborted, false);
      return stored;
    },
  );
  const response = await handler(request(), poolId);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/webp");
  assert.equal(response.headers.get("cache-control"), served);
  const etag = `"${createHash("sha256").update(stored).digest("hex")}"`;
  assert.equal(response.headers.get("etag"), etag);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), stored);
  assert.equal(
    (await handler(request("", { "if-none-match": etag }), poolId)).status,
    304,
  );
  assert.deepEqual(lookups, [poolId]);
  assert.equal(stub.calls.length, 0);
});

test("stalled downloads obey the same deadline and concurrent image work is capped", async (t) => {
  transport(t, { stall: true });
  const handler = createTokenImageHandler(
    async () => source,
    resolvePublic,
    20,
  );
  const started = Date.now();
  assert.equal((await handler(request(), poolId)).status, 404);
  assert.ok(Date.now() - started < 1000);
  let reads = 0;
  const saturated = createTokenImageHandler(
    async () => {
      reads++;
      return new Promise<string>(() => {});
    },
    resolvePublic,
    30,
  );
  const active = Array.from({ length: imagePolicy.concurrentImages }, (_, n) =>
    saturated(request(), `0x${n.toString(16).padStart(64, "0")}`),
  );
  const overflow = await saturated(request(), `0x${"f".repeat(64)}`);
  assert.equal(overflow.status, 503);
  assert.equal(overflow.headers.get("retry-after"), "5");
  assert.equal(overflow.headers.get("cache-control"), "no-store");
  assert.ok((await Promise.all(active)).every((r) => r.status === 404));
  assert.equal(reads, imagePolicy.concurrentImages);
});

test("trusted catalog request uses narrow watchlist projection and rejects mismatched identities", async (t) => {
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
  let matching = true;
  t.mock.method(globalThis, "fetch", async (url: URL, init: RequestInit) => {
    assert.equal(url.origin, "https://api.example.com");
    assert.equal(url.pathname, "/v1/explore");
    assert.equal(url.searchParams.get("view"), "watchlist");
    assert.equal(url.searchParams.get("ids"), poolId);
    assert.equal(url.searchParams.get("limit"), "1");
    assert.equal(init.redirect, "error");
    return Response.json({
      items: [
        { id: matching ? poolId : `0x${"b".repeat(64)}`, imageUrl: source },
      ],
    });
  });
  assert.equal(
    await indexedImageUrl(poolId, AbortSignal.timeout(1000)),
    source,
  );
  matching = false;
  assert.equal(await indexedImageUrl(poolId, AbortSignal.timeout(1000)), null);
});
