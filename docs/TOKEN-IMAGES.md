# Token image serving

The browser requests `/api/token-image/<poolId>/` on this website. It never
uses a creator-supplied URL as an image `src`. The route accepts only a 32-byte
pool ID and rejects all query parameters, including URL overrides.

The Node.js handler reads one matching saved catalog row from the configured
Railway API using `/v1/explore?view=watchlist&ids=<poolId>&limit=1` and checks the
returned pool identity. No RPC is called. A missing record, missing metadata,
unapproved host, unavailable service or invalid image produces an empty 404;
the UI keeps the deterministic generated token icon.

## Network and content boundaries

- Image transport is HTTPS on port 443 only. HTTP is never upgraded or fetched.
  Credentials, control characters, fragments and URL overrides are rejected.
- The exact hostname allowlist is `gateway.pinata.cloud`, `pools.trade`,
  `8c.pw` and `coffeegoofld.mypinata.cloud`. The latter three occur in committed
  launch proof metadata; the first is the explicit IPFS gateway choice below.
  There are no wildcards. Adding a host requires a reviewed code change.
- Both A and AAAA answers are resolved. Any non-public answer rejects the
  entire destination. IPv4 private, loopback, link-local, shared-address,
  multicast, reserved and documentation ranges are denied. IPv6 must be global
  unicast and outside special-purpose ranges; mapped IPv4, NAT64, unspecified,
  loopback, scoped, link-local, unique-local and multicast addresses are denied.
- The checked address is pinned in the HTTPS request's `lookup` callback.
  The original hostname remains the TLS identity, certificate validation stays
  enabled, and connection reuse is disabled. A second DNS answer cannot change
  the connection destination after validation.
- All redirects are rejected. Requests send only fixed image Accept and
  identity-encoding headers; browser cookies, authorization, referer and other
  incoming request headers are not forwarded. Upstream response headers,
  including cookies, are not copied to the browser.
- The entire operation has a 10-second deadline, including catalog lookup,
  cancellable DNS resolution, download and decoding. Sharp also has a 3-second
  processing timeout; the outer deadline covers time waiting for its worker.
- Downloads must be PNG, JPEG, WebP or GIF, with matching magic bytes. SVG,
  HTML and other formats are rejected even if mislabeled as an allowed image.
  Compressed HTTP bodies are rejected. Both advertised and streamed length are
  checked against a 2 MiB cap, with a 16 KiB response-header cap.
- Sharp decodes at most 4 million pixels, only the first animation frame, and
  re-encodes to at most 128 x 128 WebP. EXIF/ICC and other input metadata are
  stripped. Invalid/truncated raster input and pixel bombs fail. Output is
  capped at 256 KiB and served with `nosniff` and a restrictive CSP.

The Next route uses the `server-only` marker. Sharp 0.35.4 was already present
through Next; it is now an explicit web dependency so this route does not rely
on a transitive dependency remaining accessible. No new service credential is
required.

## IPFS choice and privacy

`ipfs://<CID>/<optional-path>` maps to
`https://gateway.pinata.cloud/ipfs/<CID>/<optional-path>`. CID and path syntax
are bounded; traversal and query overrides are rejected. IPNS is not enabled.
Pinata documents this as its [public gateway](https://www.pinata.cloud/blog/whats-the-difference-between-a-public-ipfs-gateway-and-a-dedicated-gateway/).
It is best-effort and can throttle or be unavailable. The fallback icon remains
part of normal behavior, not a reason to bypass validation or try arbitrary
gateway hosts.

Pinata receives the server's IP address and requested CID. It does not receive
the visitor's browser IP, wallet, cookies or page URL from this handler. Public
gateways may record access metadata; the [IPFS privacy documentation](https://docs.ipfs.tech/how-to/privacy-best-practices/)
describes this tradeoff. This implementation trusts gateway HTTPS retrieval;
it does not implement independent IPFS DAG verification.

The originally considered `ipfs.io` was rejected after a September 15, 2026
check returned HTTP 429 and a September 21 Sunset header. The IPFS project
[announced changes to its sponsored gateways](https://blog.ipfs.tech/2026-08-beyond-sponsored-gateways/).
The same committed PROLOGUE CID returned 200 `image/webp` from Pinata without a
redirect. The complete hardened request path also successfully resized it to
a 668-byte WebP. That proves this sample works, not all token images or ongoing
gateway availability.

## Lazy work and caching

Token icons mount an image only when their element approaches the viewport
(100 px margin), and also use native lazy loading. Hidden alternate layouts
do not trigger requests. Unseen catalog entries are never prefetched. Pending
and failed images retain the deterministic fallback without a layout shift.
Failed visible icons retry the same internal URL after five seconds and then
ten seconds, at most twice. This lets temporary capacity errors recover without
query overrides or endless retries. The fallback stays visible between attempts;
unmounting or changing pool identity cancels pending retry timers.

The handler coalesces simultaneous requests for one pool. Per warm process it
allows eight image operations at a time and holds at most 64 cache entries.
The output cap bounds retained image bytes to 16 MiB. Before the catalog
lookup the handler asks `resolveStoredImage` for a persisted copy of the
encoded icon. Nothing is stored today, so it returns null and a process-cache
miss takes the live path; a store hit shares the same response path, headers
and validator. Cold starts or cache eviction can cause a later request to
fetch again.

A served icon carries a strong `ETag` (SHA-256 of the output bytes) and
`Cache-Control: public, max-age=86400, s-maxage=604800,
stale-while-revalidate=604800`. Browsers and the process cache keep it for a
day, the edge for a week, and the edge may serve it stale for another week
while one request refreshes it in the background. Vercel honours `s-maxage`
and `stale-while-revalidate` and strips both from the browser copy. A request
whose `If-None-Match` matches gets an empty 304. Nothing is marked immutable:
a content-addressed IPFS CID cannot change, but a creator-hosted URL can, so a
changed image propagates within a day in the browser and about a week at the
edge.

Rejections are classed by whether a retry could change the answer. Permanent
ones (a host outside the allowlist, an invalid image URL, no image URL on
record, or a 200 whose bytes are not a usable image: wrong MIME, compressed
body, over the size caps, bad magic bytes, or a raster Sharp refuses) are
cached as an empty 404 for a day in the process cache, the browser and the
edge, so the client's 5 s and 10 s retries never reach the origin. Transient
failures (the 10-second deadline, a DNS failure, an upstream status other than
200, a network error) keep the one-minute negative cache. A malformed pool id
or any query string is refused with an empty 400 before any work; it never
takes a process-cache slot but carries the same day-long negative
`Cache-Control`. The lifetimes live in `imageLifetimes` in
`apps/web/src/lib/token-image.ts`.

## Verification

Unit tests exercise the actual request/response boundary with controlled HTTPS
transport, including the pinned lookup callback, mixed DNS answers, private
address spellings, redirect rejection, streaming size limits, fake MIME types,
real Sharp decoding/re-encoding, oversized raster dimensions, timeout behavior,
exact catalog identity, query rejection, cache coalescing, the validator and
304 path, both negative-cache classes and the stored-image seam. Browser tests
cover lazy local requests, fallback after an image failure and the built route's
invalid-request behavior. No test fetches a catalog's entire image population.
