import { createServer } from "node:http";
import { parseRequest, RequestError, type ReadRequest } from "./request";
import type { Reader } from "./reader";
import { respondTokenImage, type TokenImageService } from "./token-image-store";
import { createWalletHistory, type WalletHistory } from "./wallet-history";
import { createEthPriceService, type EthPriceService } from "./eth-price";
import type { Following } from "./following-read";

/** Small per-instance limits. We deliberately do not trust forwarded IP headers
 * or keep visitor/account records. Railway may add an edge limit separately. */
export function createApi(
  reader: Reader,
  {
    now = Date.now,
    maxPerMinute = 240,
    cacheMs = 5000,
    images = null as TokenImageService | null,
    maxImagesPerMinute = 1200,
    history = createWalletHistory({ client: null }) as WalletHistory,
    ethPrice = createEthPriceService() as EthPriceService,
    following = null as Following | null,
  } = {},
) {
  const cache = new Map<
    string,
    {
      expires: number;
      body: string;
      bytes: number;
      version: number | undefined;
    }
  >();
  let cacheBytes = 0;
  function evict(key: string) {
    cacheBytes -= cache.get(key)?.bytes ?? 0;
    cache.delete(key);
  }
  const pending = new Map<string, Promise<string>>();
  function readFollowing(wallets: string[], limit: number) {
    if (!following)
      throw new RequestError(503, "wallet_history_unavailable", {
        reason: "not_configured",
        retryAfter: 3600,
      });
    return following.read(wallets, limit);
  }
  /** Per-minute budget; returns the seconds until the window resets when spent. */
  function limiter(max: number) {
    let windowStart = now(),
      used = 0;
    return () => {
      if (now() - windowStart >= 60000) {
        windowStart = now();
        used = 0;
      }
      return ++used > max
        ? Math.max(1, Math.ceil((windowStart + 60000 - now()) / 1000))
        : null;
    };
  }
  const readBudget = limiter(maxPerMinute);
  // Icons have their own budget so a cold viewport of icons never starves
  // JSON reads, and their own in-flight bound beside the fetch slots.
  const imageBudget = limiter(maxImagesPerMinute);
  let active = 0,
    activeImages = 0;
  const server = createServer(async (req, res) => {
    const startedAt = now();
    let request: ReadRequest | undefined;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    function send(status: number, body: string) {
      res.statusCode = status;
      res.end(req.method === "HEAD" ? undefined : body);
    }
    try {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.setHeader("Allow", "GET, HEAD");
        throw new RequestError(405, "method_not_allowed");
      }
      request = parseRequest(req.url ?? "/");
      if (request.route === "health") {
        send(200, '{"ok":true}');
        return;
      }
      // Default-deny every database route, including icons and newly added
      // routes. Container health and the two independent upstreams keep their
      // own contracts. Check before caches, coalescing and database work.
      const databaseRead = !["ready", "history", "eth-price"].includes(
        request.route,
      );
      const version = databaseRead ? reader.assertReady?.() : undefined;
      const retryAfter = (
        request.route === "pool-image" ? imageBudget : readBudget
      )();
      if (retryAfter !== null) {
        res.setHeader("Retry-After", String(retryAfter));
        throw new RequestError(429, "request_limit");
      }
      if (request.route === "pool-image") {
        if (!images) throw new RequestError(404, "not_found");
        if (activeImages >= 64)
          throw new RequestError(503, "busy", { retryAfter: 5 });
        activeImages++;
        try {
          respondTokenImage(req, res, await images.resolve(request.poolId!));
        } finally {
          activeImages--;
        }
        return;
      }
      if (request.route === "eth-price") {
        const result = await ethPrice.read();
        res.setHeader(
          "Cache-Control",
          "public, max-age=60, stale-while-revalidate=540",
        );
        send(200, JSON.stringify(result));
        return;
      }
      // A rewound recent window must disappear on the very next poll.
      // Explorer history keeps its own cache with stale/fresh semantics.
      const cacheable =
        request.route !== "ready" &&
        request.route !== "history" &&
        request.route !== "pool" &&
        request.route !== "live-trades" &&
        request.route !== "following" &&
        request.route !== "trade-share";
      const hit = cache.get(request.cacheKey);
      if (cacheable && hit && hit.expires > now() && hit.version === version) {
        res.setHeader("X-Data-Cache", "HIT");
        send(200, hit.body);
        return;
      }
      let result = pending.get(request.cacheKey);
      if (!result) {
        if (active >= 16)
          throw new RequestError(503, "busy", { retryAfter: 5 });
        active++;
        result = (async () => {
          try {
            const body = JSON.stringify(
              request.route === "history"
                ? await history.read({
                    wallet: request.wallet!,
                    kind: request.kind,
                    page: request.page,
                    scope: request.scope,
                  })
                : request.route === "following"
                  ? await readFollowing(request.wallets, request.limit)
                  : await reader.read(request),
            );
            const bytes = Buffer.byteLength(body);
            if (databaseRead) reader.assertReady?.(version);
            if (bytes > 8 * 1024 * 1024) throw Error("Response exceeds bound");
            if (cacheable) {
              evict(request.cacheKey);
              while (cache.size >= 256 || cacheBytes + bytes > 16 * 1024 * 1024)
                evict(cache.keys().next().value!);
              cache.set(request.cacheKey, {
                expires: now() + cacheMs,
                body,
                bytes,
                version,
              });
              cacheBytes += bytes;
            }
            return body;
          } finally {
            active--;
          }
        })();
        pending.set(request.cacheKey, result);
        // Both handlers are required to avoid an unhandled rejecting finally promise.
        const cacheKey = request.cacheKey;
        void result.then(
          () => pending.delete(cacheKey),
          () => pending.delete(cacheKey),
        );
      }
      res.setHeader("X-Data-Cache", "MISS");
      const body = await result;
      if (databaseRead) reader.assertReady?.(version);
      send(200, body);
    } catch (error) {
      const known = error instanceof RequestError;
      // The SQLSTATE names the failure class (57014 is the statement budget)
      // without the message, which may quote SQL or values.
      if (!known)
        process.stderr.write(
          JSON.stringify({
            event: "read_failed",
            route: request?.route ?? null,
            code:
              typeof (error as { code?: unknown })?.code === "string"
                ? (error as { code: string }).code
                : null,
            ms: now() - startedAt,
          }) + "\n",
        );
      if (known && error.retryAfter)
        res.setHeader("Retry-After", String(error.retryAfter));
      send(
        known ? error.status : 503,
        JSON.stringify({
          error: known ? error.code : "data_temporarily_unavailable",
          ...(known && error.reason ? { reason: error.reason } : {}),
        }),
      );
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  server.maxRequestsPerSocket = 100;
  server.maxConnections = 64;
  return server;
}
