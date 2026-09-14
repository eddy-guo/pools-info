import { createServer } from "node:http";
import { parseRequest, RequestError } from "./request";
import type { Reader } from "./reader";

/** Small per-instance limits. We deliberately do not trust forwarded IP headers
 * or keep visitor/account records. Railway may add an edge limit separately. */
export function createApi(
  reader: Reader,
  { now = Date.now, maxPerMinute = 240, cacheMs = 5000 } = {},
) {
  const cache = new Map<
    string,
    { expires: number; body: string; bytes: number }
  >();
  let cacheBytes = 0;
  function evict(key: string) {
    cacheBytes -= cache.get(key)?.bytes ?? 0;
    cache.delete(key);
  }
  const pending = new Map<string, Promise<string>>();
  let windowStart = now(),
    used = 0,
    active = 0;
  const server = createServer(async (req, res) => {
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
      const request = parseRequest(req.url ?? "/");
      if (request.route === "health") {
        send(200, '{"ok":true}');
        return;
      }
      if (now() - windowStart >= 60000) {
        windowStart = now();
        used = 0;
      }
      if (++used > maxPerMinute) {
        res.setHeader(
          "Retry-After",
          String(Math.max(1, Math.ceil((windowStart + 60000 - now()) / 1000))),
        );
        throw new RequestError(429, "request_limit");
      }
      const hit = cache.get(request.cacheKey);
      if (request.route !== "ready" && hit && hit.expires > now()) {
        res.setHeader("X-Data-Cache", "HIT");
        send(200, hit.body);
        return;
      }
      let result = pending.get(request.cacheKey);
      if (!result) {
        if (active >= 16) throw new RequestError(503, "busy");
        active++;
        result = (async () => {
          try {
            const body = JSON.stringify(await reader.read(request));
            const bytes = Buffer.byteLength(body);
            if (bytes > 8 * 1024 * 1024) throw Error("Response exceeds bound");
            if (request.route !== "ready") {
              evict(request.cacheKey);
              while (cache.size >= 256 || cacheBytes + bytes > 16 * 1024 * 1024)
                evict(cache.keys().next().value!);
              cache.set(request.cacheKey, {
                expires: now() + cacheMs,
                body,
                bytes,
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
        void result.then(
          () => pending.delete(request.cacheKey),
          () => pending.delete(request.cacheKey),
        );
      }
      res.setHeader("X-Data-Cache", "MISS");
      send(200, await result);
    } catch (error) {
      const known = error instanceof RequestError;
      if (!known) process.stderr.write('{"event":"read_failed"}\n');
      send(
        known ? error.status : 503,
        JSON.stringify({
          error: known ? error.code : "data_temporarily_unavailable",
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
