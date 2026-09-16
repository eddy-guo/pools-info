import { Resolver } from "node:dns/promises";
import https from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import sharp from "sharp";

/** Creator image fetch and re-encode policy, shared by the read API's image
 * store and the website's proxy. Hosts, address checks, transport limits and
 * the Sharp pipeline are the security boundary; nothing here reads a pool
 * catalog or caches bytes. */
export const imagePolicy = {
  ipfsGateway: "https://gateway.pinata.cloud",
  maxBytes: 2 * 1024 * 1024,
  maxPixels: 4_000_000,
  maxOutputBytes: 256 * 1024,
  edge: 128,
} as const;
// Exact hosts found in reviewed launch proof metadata, plus the chosen IPFS
// gateway. Expanding this set is a reviewed code change, never a query option.
export const imageHosts = new Set([
  "gateway.pinata.cloud",
  "pools.trade",
  "8c.pw",
  "coffeegoofld.mypinata.cloud",
]);
/** Why an image was not produced. `source_rejected` is decided by the pure URL
 * policy without network use and can only change with a deploy; `timeout` is
 * the caller's deadline; the rest describe the failing stage. */
export type TokenImageReason =
  | "source_rejected"
  | "dns_rejected"
  | "fetch_rejected"
  | "decode_rejected"
  | "timeout";
export class TokenImageError extends Error {
  constructor(
    public readonly reason: TokenImageReason,
    options?: { cause?: unknown },
  ) {
    super("Token image unavailable", options);
    this.name = "TokenImageError";
  }
}
const invalid = (reason: TokenImageReason, cause?: unknown) =>
  new TokenImageError(reason, cause === undefined ? undefined : { cause });
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

/** Pure source policy: HTTPS on the exact host allowlist, or a bounded IPFS
 * path mapped to the gateway. Throws `source_rejected`; performs no I/O. */
export function tokenImageUrl(source: string): URL {
  if (
    !source ||
    source.length > 2048 ||
    /[\u0000-\u0020\u007f-\u009f\\]/u.test(source)
  )
    throw invalid("source_rejected");
  if (source.startsWith("ipfs://")) {
    // Keep CIDv0 case intact; URL.hostname would lowercase a base58 CID.
    const ipfs = /^ipfs:\/\/(?:ipfs\/)?([^/?#]+)(\/[^?#]*)?$/u.exec(source);
    if (
      !ipfs ||
      !/^(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{31,119})$/u.test(ipfs[1])
    )
      throw invalid("source_rejected");
    const path = ipfs[2] ?? "";
    for (const segment of path.split("/")) {
      let decoded: string;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        throw invalid("source_rejected");
      }
      if (
        decoded === "." ||
        decoded === ".." ||
        /[\/\\\u0000-\u0020\u007f]/u.test(decoded)
      )
        throw invalid("source_rejected");
    }
    source = `${imagePolicy.ipfsGateway}/ipfs/${ipfs[1]}${path}`;
  }
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw invalid("source_rejected");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    !url.hostname ||
    url.hash
  )
    throw invalid("source_rejected");
  const host = url.hostname.replace(/^\[|\]$/gu, "");
  if (!imageHosts.has(host)) throw invalid("source_rejected");
  if (isIP(host) && !publicImageAddress(host)) throw invalid("source_rejected");
  if (
    !isIP(host) &&
    (!host.includes(".") ||
      host.endsWith(".") ||
      /(?:^|\.)(?:localhost|local|internal|home|lan|test|invalid)$/iu.test(
        host,
      ))
  )
    throw invalid("source_rejected");
  return url;
}

type Resolved = { address: string; family: number };
export type ImageResolver = (
  host: string,
  signal: AbortSignal,
) => Promise<Resolved[]>;
export const resolveImage: ImageResolver = async (host, signal) => {
  const resolver = new Resolver();
  const cancel = () => resolver.cancel();
  signal.throwIfAborted();
  signal.addEventListener("abort", cancel, { once: true });
  const absent = (error: NodeJS.ErrnoException): string[] => {
    if (error.code === "ENODATA" || error.code === "ENOTFOUND") return [];
    throw invalid("dns_rejected", error);
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
function abortable<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  reason: TokenImageReason,
): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(invalid(reason));
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
    : await abortable(resolver(hostname, signal), signal, "dns_rejected");
  if (
    !addresses.length ||
    addresses.some(
      (a) => !publicImageAddress(a.address) || isIP(a.address) !== a.family,
    )
  )
    throw invalid("dns_rejected");
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
          const mime = String(response.headers["content-type"] ?? "")
            .split(";")[0]
            .trim()
            .toLowerCase();
          const length = response.headers["content-length"];
          if (
            response.statusCode !== 200 ||
            !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(
              mime,
            ) ||
            (response.headers["content-encoding"] &&
              response.headers["content-encoding"] !== "identity") ||
            (length !== undefined &&
              (!/^\d+$/u.test(length) || Number(length) > imagePolicy.maxBytes))
          ) {
            response.destroy();
            request.destroy();
            reject(invalid("fetch_rejected"));
            return;
          }
          const chunks: Buffer[] = [];
          let bytes = 0;
          response.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > imagePolicy.maxBytes) {
              response.destroy();
              request.destroy();
              reject(invalid("fetch_rejected"));
            } else chunks.push(chunk);
          });
          response.once("end", () =>
            resolve({ bytes: Buffer.concat(chunks), mime }),
          );
          response.once("error", (error) =>
            reject(invalid("fetch_rejected", error)),
          );
          response.once("aborted", () => reject(invalid("fetch_rejected")));
        },
      );
      request.once("error", (error) =>
        reject(invalid("fetch_rejected", error)),
      );
      request.end();
    }),
    signal,
    "fetch_rejected",
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

/** Validate, fetch through the pinned address, and re-encode one creator
 * image as a 128 px WebP. Every failure is a `TokenImageError`; once `signal`
 * has fired the reason is `timeout` regardless of the stage that noticed. */
export async function transformedTokenImage(
  source: string,
  signal: AbortSignal,
  resolver: ImageResolver = resolveImage,
): Promise<Buffer> {
  try {
    const { bytes, mime } = await imageBytes(
      tokenImageUrl(source),
      signal,
      resolver,
    );
    if (!rasterMatches(bytes, mime)) throw invalid("decode_rejected");
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
      const output = await abortable(
        transform.toBuffer(),
        signal,
        "decode_rejected",
      );
      if (!output.length || output.length > imagePolicy.maxOutputBytes)
        throw invalid("decode_rejected");
      return output;
    } finally {
      signal.removeEventListener("abort", abort);
    }
  } catch (error) {
    if (signal.aborted) throw invalid("timeout", error);
    if (error instanceof TokenImageError) throw error;
    // Sharp rejects pixel bombs, truncated input and its own timeout here.
    throw invalid("decode_rejected", error);
  }
}
