import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { IncomingMessage, ClientRequest } from "node:http";
import type { LookupFunction } from "node:net";
import sharp from "sharp";
import {
  imagePolicy,
  publicImageAddress,
  TokenImageError,
  tokenImageUrl,
  transformedTokenImage,
} from "./index";

const cid = "bafkreibxargr7pdwdydhztyg2dbbkm4oueutbsfjcwcp24zrhlyem55iru";
const source = "https://pools.trade/icon.png";
const resolvePublic = async () => [{ address: "93.184.216.34", family: 4 }];

function transport(
  t: TestContext,
  options: {
    bytes?: Buffer;
    mime?: string;
    status?: number;
    contentLength?: string;
    encoding?: string;
    stall?: boolean;
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
async function rejectedWith(operation: Promise<unknown>, reason: string) {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof TokenImageError);
    assert.equal(error.reason, reason);
    return true;
  });
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
  for (const value of [
    "https://unreviewed-public-host.com/icon.png",
    "https://desperate-moccasin-minnow.myfilebase.com/ipfs/x.png",
    "http://images.example.com/a",
    "file:///etc/passwd",
    "data:image/png,a",
    "not a url",
    "",
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
    `ipfs://${cid}/%zz`,
    `ipfs://${cid}?url=private`,
    "ipns://some-name/a",
    `https://images.example.com/${"a".repeat(2048)}`,
  ])
    assert.throws(
      () => tokenImageUrl(value),
      (error: unknown) =>
        error instanceof TokenImageError && error.reason === "source_rejected",
      value,
    );
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
  assert.deepEqual(Object.keys(stub.calls[0].options.headers!), [
    "Accept",
    "Accept-Encoding",
  ]);
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
  assert.ok(image.length <= imagePolicy.maxOutputBytes);
});

test("mixed/private DNS answers fail before opening an HTTPS connection", async (t) => {
  const stub = transport(t);
  for (const values of [
    [],
    [{ address: "127.0.0.1", family: 4 }],
    [{ address: "169.254.169.254", family: 4 }],
    [
      { address: "93.184.216.34", family: 4 },
      { address: "fc00::1", family: 6 },
    ],
    [{ address: "::ffff:93.184.216.34", family: 6 }],
    [{ address: "93.184.216.34", family: 6 }],
  ])
    await rejectedWith(
      transformedTokenImage(
        source,
        AbortSignal.timeout(1000),
        async () => values,
      ),
      "dns_rejected",
    );
  await rejectedWith(
    transformedTokenImage(source, AbortSignal.timeout(1000), async () => {
      throw new TokenImageError("dns_rejected");
    }),
    "dns_rejected",
  );
  assert.equal(stub.calls.length, 0);
  await rejectedWith(
    transformedTokenImage(
      "https://unreviewed-public-host.com/icon.png",
      AbortSignal.timeout(1000),
      resolvePublic,
    ),
    "source_rejected",
  );
  assert.equal(stub.calls.length, 0);
});

test("redirects, encoded/oversized bodies and MIME confusion are rejected at the request boundary", async (t) => {
  const png = await sharp({
    create: { width: 2, height: 2, channels: 3, background: "blue" },
  })
    .png()
    .toBuffer();
  for (const [options, reason] of [
    [{ status: 302, bytes: png }, "fetch_rejected"],
    [{ status: 404, bytes: Buffer.alloc(0) }, "fetch_rejected"],
    [
      { contentLength: String(imagePolicy.maxBytes + 1), bytes: png },
      "fetch_rejected",
    ],
    [{ contentLength: "NaN", bytes: png }, "fetch_rejected"],
    [{ bytes: Buffer.alloc(imagePolicy.maxBytes + 1) }, "fetch_rejected"],
    [{ encoding: "gzip", bytes: png }, "fetch_rejected"],
    [
      { mime: "text/html", bytes: Buffer.from("<html></html>") },
      "fetch_rejected",
    ],
    [
      { mime: "image/svg+xml", bytes: Buffer.from("<svg></svg>") },
      "fetch_rejected",
    ],
    [
      {
        mime: "image/png",
        bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      },
      "decode_rejected",
    ],
    [{ mime: "image/jpeg", bytes: png }, "decode_rejected"],
    [{ bytes: png.subarray(0, 16) }, "decode_rejected"],
  ] as const) {
    await t.test(
      JSON.stringify({ ...options, bytes: options.bytes.length, reason }),
      async (sub) => {
        const stub = transport(sub, options);
        await rejectedWith(
          transformedTokenImage(
            source,
            AbortSignal.timeout(1000),
            resolvePublic,
          ),
          reason,
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
        error instanceof TokenImageError &&
        error.reason === "decode_rejected" &&
        /pixel limit/.test(String((error.cause as Error)?.message)),
    );
  });
});

test("an expired deadline reports timeout whether DNS, download or decoding stalled", async (t) => {
  await rejectedWith(
    transformedTokenImage(
      source,
      AbortSignal.timeout(20),
      () => new Promise(() => {}),
    ),
    "timeout",
  );
  transport(t, { stall: true });
  const started = Date.now();
  await rejectedWith(
    transformedTokenImage(source, AbortSignal.timeout(20), resolvePublic),
    "timeout",
  );
  assert.ok(Date.now() - started < 1000);
  const already = AbortSignal.abort();
  await rejectedWith(
    transformedTokenImage(source, already, resolvePublic),
    "timeout",
  );
});
