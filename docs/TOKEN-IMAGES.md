# Token image serving

The browser requests `/api/token-image/<poolId>/` on this website. It never
uses a creator-supplied URL as an image `src`. The route accepts only a 32-byte
pool ID and rejects all query parameters, including URL overrides.

The Node.js handler reads that pool's stored icon from the read API's token
icon store and relays it. It fetches no creator host and no IPFS gateway, runs
no image decoder, and holds no image bytes between requests: the store owns the
whole upstream pipeline and the caching authority. A missing record, missing
metadata, rejected source or unusable image produces an empty 404 and the UI
keeps the deterministic generated token icon.

## The store this route reads

`GET` or `HEAD /v1/pools/<poolId>/image` on the read API (`apps/api`,
documented under "Token icon store" in its README) serves one pool's creator
image as a 128 x 128 WebP from the `token_images` table. The first view of a
pool runs the shared `@pools/token-image` policy inside that request - exact
host allowlist, DNS answers checked against private-address block lists and
pinned, HTTPS only, 2 MiB and 4-megapixel caps, content-type and magic-byte
checks, Sharp decode and WebP re-encode - then stores the bytes, their SHA-256
(the `ETag`) and the catalog `image_url` they came from. That first view has a
10-second upstream budget (the Pinata public gateway measured 3.9 s on a
production success) and eight concurrent fetches per process, and a separate
12-second cap bounds one request's combined time queueing for a fetch slot and
running the fetch. Every later view anywhere is one primary-key read. A
replaced catalog `image_url` re-encodes on the pool's next view. Nothing
prefetches, warms or sweeps the catalog: a browser request is the only trigger,
across all 62k pools.

That policy used to run in this web process, per warm instance, behind a
process cache. It now runs once per pool for the whole product, which is what
made a cold screener stop waiting on creator hosts. The allowlist, the address
checks, the size and pixel caps and the decoder live in
`packages/token-image`; the web app does not depend on that package and does
not duplicate any of it.

## What the proxy relays

The store's base is the same `INDEXER_API_URL` the product proxy uses, and is
validated the same way: a bare `http`/`https` origin with no credentials, path,
query or fragment. With no usable base configured - or with
`CHAIN_REFRESH_DISABLED=1`, as the Playwright suite runs - no request is made
and every pool's icon is simply absent.

- `200` relays the store's `ETag`, `Content-Length` and the lifetimes from its
  `Cache-Control`, with `Content-Type: image/webp` pinned by this route rather
  than taken from the store. A store response that is not a bounded WebP body
  (wrong content type, absent body, a length that disagrees with the body, or
  more than 512 KiB) never reaches the browser.
- `If-None-Match` is relayed as sent, so the store performs the weak
  comparison; its `304` becomes a `304` with the same validator and lifetimes.
  `HEAD` asks the store for `HEAD`, so a validator check transfers no bytes.
- The store's JSON `404` becomes an empty `404` with exactly the negative
  lifetime the store stated, whatever its reason was: `pool_not_indexed`
  (300 s), `no_source` or `source_rejected` (a day), or a transient
  `dns_rejected`, `fetch_rejected` or `decode_rejected` (300 s, doubling per
  repeat up to a day) or `timeout` (the same doubling, capped at an hour,
  since a deadline expiry only proves that one fetch was slow). The reason is
  the store's operational detail and is not shown; the generated icon is the
  website's answer to all of them. A `404` that states no lifetime falls back
  to 300 s.
- `503 busy`, `429` from the store's request budget, an unexpected status, an
  unreachable store and this route's own 13-second deadline all become `503`
  with `Cache-Control: no-store` and a `Retry-After` - the store's own value
  when it sent a usable one, otherwise 5 seconds. Rate limiting is relayed as
  `503` because it is this gateway that is temporarily unable to serve, not
  anything the visitor did. Nothing transient is ever cached.
- A malformed pool ID or any query string is refused with an empty `400`
  before the store is contacted, carrying a day-long negative `Cache-Control`
  because such a request can never become valid.
- Only `If-None-Match` and a fixed `Accept: image/webp` are sent upstream:
  browser cookies, authorization and referer never reach the store. Responses
  are built from a fixed header set, so no store header - including a cookie -
  reaches the browser. Redirects are rejected and bytes are served with
  `nosniff` and a restrictive CSP.

The route uses the `server-only` marker. The 13-second deadline sits above the
store's own 12-second per-request cap, so a pool's first view receives the
store's honest answer - the icon, or a cacheable `404` - rather than an
uncached `503` from this route, while staying inside the route's 15-second
platform limit. No new service credential is required, and this route no
longer uses Sharp; the web app keeps that dependency only for the wallet PnL
card route (`apps/web/src/app/cards/[filename]/route.tsx`). The lifetimes and
the fallbacks live in `imageLifetimes` in `apps/web/src/lib/token-image.ts`;
the store read itself is `resolveStoredImage` in the same file.

## Lazy work and caching

Token icons mount an image only when their element approaches the viewport
(100 px margin), and also use native lazy loading. Hidden alternate layouts
do not trigger requests. Unseen catalog entries are never prefetched. Pending
and failed images retain the deterministic fallback without a layout shift.
Failed visible icons retry the same internal URL after five seconds and then
ten seconds, at most twice. This lets temporary capacity errors recover without
query overrides or endless retries. The fallback stays visible between attempts;
unmounting or changing pool identity cancels pending retry timers.

Caching lives in one place: the lifetimes the store states, which this route
relays. A served icon is kept by the browser for a day and by the edge for a
month, and the edge may serve it stale for another week while one request
refreshes it. Vercel honours `s-maxage` and `stale-while-revalidate` and strips
both from the browser copy. Nothing is marked immutable: a creator-hosted URL
can change, so a replaced image propagates within a day in the browser and
about a month at the edge. This route keeps no process-local copy of any image,
so a cold start costs nothing beyond one primary-key read at the store.

## IPFS choice and privacy

`ipfs://<CID>/<optional-path>` maps to
`https://gateway.pinata.cloud/ipfs/<CID>/<optional-path>` inside the store, and
only on a pool's first view. Pinata documents this as its
[public gateway](https://www.pinata.cloud/blog/whats-the-difference-between-a-public-ipfs-gateway-and-a-dedicated-gateway/).
It is best-effort and can throttle or be unavailable. The fallback icon remains
part of normal behavior, not a reason to bypass validation or try arbitrary
gateway hosts.

Pinata receives the read API's IP address and the requested CID, once per
image rather than once per warm web instance. It does not receive the visitor's
browser IP, wallet, cookies or page URL. Public gateways may record access
metadata; the [IPFS privacy documentation](https://docs.ipfs.tech/how-to/privacy-best-practices/)
describes this tradeoff. The store trusts gateway HTTPS retrieval; it does not
implement independent IPFS DAG verification.

The originally considered `ipfs.io` was rejected after a September 15, 2026
check returned HTTP 429 and a September 21 Sunset header. The IPFS project
[announced changes to its sponsored gateways](https://blog.ipfs.tech/2026-08-beyond-sponsored-gateways/).

## Verification

Unit tests in `apps/web/src/lib/token-image.test.ts` exercise the route's own
input validation, the documented store endpoint and the request it sends, each
store status mapped onto a response class, the relayed validator and `304`
path, `HEAD`, the negative lifetimes, the bounded-body and content-type checks
on the store's response, a store that states unusable lifetimes or a weak
validator, and an absent or unusable read API base. Browser tests cover lazy
local requests, fallback after an image failure, bounded retries and the built
route's invalid-request behavior. The store's own policy - DNS pinning,
MIME/body checks and real Sharp re-encoding - is tested in
`packages/token-image` and `apps/api`. No test fetches a catalog's entire image
population.
