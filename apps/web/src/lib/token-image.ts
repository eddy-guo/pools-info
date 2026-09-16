import { createHash } from "node:crypto";
import { Resolver } from "node:dns/promises";
import https from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import sharp from "sharp";

export const imagePolicy = {
  ipfsGateway: "https://gateway.pinata.cloud",
  timeoutMs: 10000,
  maxBytes: 2 * 1024 * 1024,
  maxPixels: 4_000_000,
  maxOutputBytes: 256 * 1024,
  edge: 128,
  cacheEntries: 64,
  concurrentImages: 8,
} as const;
// Lifetimes in seconds. The edge keeps a served icon for a week and may keep
// serving it stale for another week while one request refreshes it; browsers
// and the process cache keep it for a day. A content-addressed IPFS CID cannot
// change but a creator-hosted URL can, so nothing is marked immutable. A
// permanent rejection (policy, invalid URL, unusable bytes) is remembered for
// a day; a transient failure (timeout, upstream error, network) for a minute.
export const imageLifetimes = {
  browser: 86400,
  edge: 604800,
  staleWhileRevalidate: 604800,
  rejected: 86400,
  unavailable: 60,
} as const;
// Exact hosts found in reviewed launch proof metadata, plus the chosen IPFS
// gateway. Expanding this set is a reviewed code change, never a query option.
export const imageHosts = new Set([
  "gateway.pinata.cloud",
  "pools.trade",
  "8c.pw",
  "coffeegoofld.mypinata.cloud",
]);
/** Permanent rejections follow the long negative cache, transient failures the short one. */
export class ImageRejection extends Error {
  constructor(
    readonly permanent: boolean,
    options?: ErrorOptions,
  ) {
    super("Token image unavailable", options);
  }
}
const rejected = () => new ImageRejection(true);
const unavailable = () => new ImageRejection(false);
const poolPattern = /^0x[0-9a-f]{64}$/i;
const denied = new BlockList();
// Conservative IANA special-purpose exclusions, including globally reachable
// special-use ranges. No image fetch needs these protocol/service destinations.
for (const [network, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.31.196.0", 24],
  ["192.52.193.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["192.175.48.0", 24],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  denied.addSubnet(network, bits, "ipv4");
for (const [network, bits] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["2620:4f:8000::", 48],
  ["3ffe::", 16],
  ["3fff::", 20],
] as const)
  denied.addSubnet(network, bits, "ipv6");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");

export function publicImageAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !denied.check(address, "ipv4");
  // Only global unicast. This also rejects mapped/compatible IPv4, NAT64,
  // loopback, unspecified, link-local, ULA, multicast and scoped addresses.
  return (
    family === 6 &&
    !address.includes("%") &&
    globalV6.check(address, "ipv6") &&
    !denied.check(address, "ipv6")
  );
}

export function tokenImageUrl(source: string): URL {
  if (
    !source ||
    source.length > 2048 ||
    /[\u0000-\u0020\u007f-\u009f\\]/u.test(source)
  )
    throw rejected();
  if (source.startsWith("ipfs://")) {
    // Keep CIDv0 case intact; URL.hostname would lowercase a base58 CID.
    const ipfs = /^ipfs:\/\/(?:ipfs\/)?([^/?#]+)(\/[^?#]*)?$/u.exec(source);
    if (
      !ipfs ||
      !/^(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{31,119})$/u.test(ipfs[1])
    )
      throw rejected();
    const path = ipfs[2] ?? "";
    for (const segment of path.split("/")) {
      const decoded = decodeURIComponent(segment);
      if (
        decoded === "." ||
        decoded === ".." ||
        /[\/\\\u0000-\u0020\u007f]/u.test(decoded)
      )
        throw rejected();
    }
    source = `${imagePolicy.ipfsGateway}/ipfs/${ipfs[1]}${path}`;
  }
  const url = new URL(source);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    !url.hostname ||
    url.hash
  )
    throw rejected();
  const host = url.hostname.replace(/^\[|\]$/gu, "");
  if (!imageHosts.has(host)) throw rejected();
  if (isIP(host) && !publicImageAddress(host)) throw rejected();
  if (
    !isIP(host) &&
    (!host.includes(".") ||
      host.endsWith(".") ||
      /(?:^|\.)(?:localhost|local|internal|home|lan|test|invalid)$/iu.test(
        host,
      ))
  )
    throw rejected();
  return url;
}

type Resolved = { address: string; family: number };
export type ImageResolver = (
  host: string,
  signal: AbortSignal,
) => Promise<Resolved[]>;
const resolveImage: ImageResolver = async (host, signal) => {
  const resolver = new Resolver();
  const cancel = () => resolver.cancel();
  signal.throwIfAborted();
  signal.addEventListener("abort", cancel, { once: true });
  const absent = (error: NodeJS.ErrnoException): string[] => {
    if (error.code === "ENODATA" || error.code === "ENOTFOUND") return [];
    throw unavailable();
  };
  try {
    const [v4, v6] = await Promise.all([
      resolver.resolve4(host).catch(absent),
      resolver.resolve6(host).catch(absent),
    ]);
    return [
      ...v4.map((address) => ({ address, family: 4 })),
      ...v6.map((address) => ({ address, family: 6 })),
    ];
  } finally {
    signal.removeEventListener("abort", cancel);
    resolver.cancel();
  }
};
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(unavailable());
    signal.addEventListener("abort", abort, { once: true });
    operation
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

async function imageBytes(
  url: URL,
  signal: AbortSignal,
  resolver: ImageResolver,
) {
  const hostname = url.hostname.replace(/^\[|\]$/gu, "");
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await abortable(resolver(hostname, signal), signal);
  if (
    !addresses.length ||
    addresses.some(
      (a) => !publicImageAddress(a.address) || isIP(a.address) !== a.family,
    )
  )
    throw unavailable();
  signal.throwIfAborted();
  const pinned = addresses[0];
  // Node may ask for all addresses. Return only the checked address in either
  // form. The TLS hostname remains the original URL hostname, not the IP.
  const pinnedLookup: LookupFunction = (_host, options, callback) => {
    if (options.all) callback(null, [pinned]);
    else callback(null, pinned.address, pinned.family);
  };
  return abortable(
    new Promise<{ bytes: Buffer; mime: string }>((resolve, reject) => {
      const request = https.request(
        url,
        {
          method: "GET",
          agent: false,
          lookup: pinnedLookup,
          family: pinned.family,
          signal,
          maxHeaderSize: 16384,
          rejectUnauthorized: true,
          headers: {
            Accept: "image/png,image/jpeg,image/webp,image/gif",
            "Accept-Encoding": "identity",
          },
        },
        (response) => {
          const fail = (error: ImageRejection) => {
            response.destroy();
            request.destroy();
            reject(error);
          };
          // Anything but a 200 may be a passing upstream condition; what a
          // 200 actually serves is the host's chosen representation.
          if (response.statusCode !== 200) return fail(unavailable());
          const mime = String(response.headers["content-type"] ?? "")
            .split(";")[0]
            .trim()
            .toLowerCase();
          const length = response.headers["content-length"];
          if (
            !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(
              mime,
            ) ||
            (response.headers["content-encoding"] &&
              response.headers["content-encoding"] !== "identity") ||
            (length !== undefined &&
              (!/^\d+$/u.test(length) || Number(length) > imagePolicy.maxBytes))
          )
            return fail(rejected());
          const chunks: Buffer[] = [];
          let bytes = 0;
          response.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > imagePolicy.maxBytes) fail(rejected());
            else chunks.push(chunk);
          });
          response.once("end", () =>
            resolve({ bytes: Buffer.concat(chunks), mime }),
          );
          response.once("error", () => reject(unavailable()));
          response.once("aborted", () => reject(unavailable()));
        },
      );
      request.once("error", () => reject(unavailable()));
      request.end();
    }),
    signal,
  );
}

function rasterMatches(bytes: Buffer, mime: string): boolean {
  if (mime === "image/png")
    return bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mime === "image/jpeg")
    return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (mime === "image/gif")
    return ["GIF87a", "GIF89a"].includes(
      bytes.subarray(0, 6).toString("ascii"),
    );
  return (
    mime === "image/webp" &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  );
}

export async function transformedTokenImage(
  source: string,
  signal: AbortSignal,
  resolver = resolveImage,
): Promise<Buffer> {
  const { bytes, mime } = await imageBytes(
    tokenImageUrl(source),
    signal,
    resolver,
  );
  if (!rasterMatches(bytes, mime)) throw rejected();
  signal.throwIfAborted();
  const transform = sharp(bytes, {
    limitInputPixels: imagePolicy.maxPixels,
    failOn: "warning",
    animated: false,
    pages: 1,
  })
    .rotate()
    .resize(imagePolicy.edge, imagePolicy.edge, {
      fit: "cover",
      withoutEnlargement: true,
    })
    .webp({ quality: 80 })
    .timeout({ seconds: 3 });
  const abort = () => transform.destroy();
  signal.addEventListener("abort", abort, { once: true });
  try {
    let output: Buffer;
    try {
      output = await abortable(transform.toBuffer(), signal);
    } catch (error) {
      // Sharp refused the raster itself; only the deadline is transient.
      if (error instanceof ImageRejection || signal.aborted) throw error;
      throw new ImageRejection(true, { cause: error });
    }
    if (!output.length || output.length > imagePolicy.maxOutputBytes)
      throw rejected();
    return output;
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

async function boundedJson(response: Response, signal: AbortSignal) {
  if (!response.ok || !response.body) throw unavailable();
  const reader = response.body.getReader();
  let length = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      length += value.byteLength;
      if (length > 128 * 1024) throw unavailable();
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export async function indexedImageUrl(
  poolId: string,
  signal: AbortSignal,
): Promise<string | null> {
  if (!poolPattern.test(poolId)) throw rejected();
  const configured = process.env.INDEXER_API_URL;
  if (!configured || process.env.CHAIN_REFRESH_DISABLED === "1") return null;
  const origin = new URL(configured);
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  )
    throw rejected();
  const url = new URL("/v1/explore", origin);
  url.search = new URLSearchParams({
    view: "watchlist",
    ids: poolId.toLowerCase(),
    limit: "1",
  }).toString();
  const response = await fetch(url, {
    cache: "no-store",
    redirect: "error",
    signal,
  });
  const data = await boundedJson(response, signal);
  if (
    !data ||
    !Array.isArray(data.items) ||
    data.items.length !== 1 ||
    data.items[0]?.id?.toLowerCase() !== poolId.toLowerCase()
  )
    return null;
  return typeof data.items[0].imageUrl === "string"
    ? data.items[0].imageUrl
    : null;
}

export type StoredImageSource = (
  poolId: string,
  signal: AbortSignal,
) => Promise<Buffer | null>;
/**
 * Persistent per-pool image store: the 128 px WebP encoded once on first view
 * and served from storage afterwards. The data side plugs its store in here;
 * until then nothing is stored and a process-cache miss takes the live path.
 */
export const resolveStoredImage: StoredImageSource = async () => null;

type Outcome =
  { bytes: Buffer; etag: string } | { bytes: null; permanent: boolean };
const entityTag = (bytes: Buffer) =>
  `"${createHash("sha256").update(bytes).digest("hex")}"`;
// If-None-Match uses weak comparison, so a W/ prefix still matches.
const matchesEntityTag = (header: string | null, etag: string) =>
  (header ?? "")
    .split(",")
    .map((tag) => tag.trim().replace(/^W\//u, ""))
    .some((tag) => tag === "*" || tag === etag);
const servedCacheControl = `public, max-age=${imageLifetimes.browser}, s-maxage=${imageLifetimes.edge}, stale-while-revalidate=${imageLifetimes.staleWhileRevalidate}`;
const negativeCacheControl = (permanent: boolean) => {
  const seconds = permanent
    ? imageLifetimes.rejected
    : imageLifetimes.unavailable;
  return `public, max-age=${seconds}, s-maxage=${seconds}`;
};

/** Factory makes process-local caching testable; no pool scan or image prefetch. */
export function createTokenImageHandler(
  readUrl = indexedImageUrl,
  resolver = resolveImage,
  timeoutMs: number = imagePolicy.timeoutMs,
  storedImage = resolveStoredImage,
) {
  const cache = new Map<string, { expires: number; outcome: Outcome }>();
  const pending = new Map<string, Promise<Outcome>>();
  return async (request: Request, poolId: string): Promise<Response> => {
    if (!poolPattern.test(poolId) || new URL(request.url).search)
      // Refused before any work, so it never takes a process cache slot; the
      // browser and edge may still hold the empty response for a day.
      return new Response(null, {
        status: 400,
        headers: { "Cache-Control": negativeCacheControl(true) },
      });
    const key = poolId.toLowerCase();
    const remembered = cache.get(key);
    let outcome: Outcome;
    if (remembered && remembered.expires > Date.now())
      outcome = remembered.outcome;
    else {
      let task = pending.get(key);
      if (!task) {
        if (pending.size >= imagePolicy.concurrentImages)
          return new Response(null, {
            status: 503,
            headers: { "Cache-Control": "no-store", "Retry-After": "5" },
          });
        task = (async (): Promise<Outcome> => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeoutMs);
          try {
            const stored = await abortable(
              storedImage(key, controller.signal),
              controller.signal,
            );
            if (stored) return { bytes: stored, etag: entityTag(stored) };
            const source = await abortable(
              readUrl(key, controller.signal),
              controller.signal,
            );
            if (!source) return { bytes: null, permanent: true };
            const bytes = await transformedTokenImage(
              source,
              controller.signal,
              resolver,
            );
            return { bytes, etag: entityTag(bytes) };
          } catch (error) {
            return {
              bytes: null,
              permanent: error instanceof ImageRejection && error.permanent,
            };
          } finally {
            clearTimeout(timer);
          }
        })();
        pending.set(key, task);
      }
      outcome = await task;
      pending.delete(key);
      cache.delete(key);
      if (cache.size >= imagePolicy.cacheEntries)
        cache.delete(cache.keys().next().value!);
      const seconds = outcome.bytes
        ? imageLifetimes.browser
        : outcome.permanent
          ? imageLifetimes.rejected
          : imageLifetimes.unavailable;
      cache.set(key, { outcome, expires: Date.now() + seconds * 1000 });
    }
    if (!outcome.bytes)
      return new Response(null, {
        status: 404,
        headers: {
          "Content-Type": "image/webp",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "default-src 'none'; sandbox",
          "Cache-Control": negativeCacheControl(outcome.permanent),
          "Content-Disposition": 'inline; filename="token.webp"',
        },
      });
    if (matchesEntityTag(request.headers.get("if-none-match"), outcome.etag))
      return new Response(null, {
        status: 304,
        headers: { ETag: outcome.etag, "Cache-Control": servedCacheControl },
      });
    return new Response(Uint8Array.from(outcome.bytes), {
      status: 200,
      headers: {
        "Content-Type": "image/webp",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Cache-Control": servedCacheControl,
        ETag: outcome.etag,
        "Content-Disposition": 'inline; filename="token.webp"',
      },
    });
  };
}
