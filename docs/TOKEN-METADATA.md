# Factory metadata evidence

The Robinhood catalog collector includes the known UERC20Factory
`0x000000e200088d55c39a11f609e5f667729ad49b` in its existing discovery log query.
It does not perform a second historical pass or query a token-list API.

## Pinned ABI and observed chain evidence

The ABI comes from Uniswap's `uerc20-factory` repository, pinned to
[`de5bacd215f6aae50e524297c18fcf78b69b6312`](https://github.com/Uniswap/uerc20-factory/tree/de5bacd215f6aae50e524297c18fcf78b69b6312):

- [`ITokenFactory.sol`](https://github.com/Uniswap/uerc20-factory/blob/de5bacd215f6aae50e524297c18fcf78b69b6312/src/interfaces/ITokenFactory.sol)
  defines a **non-indexed** token address and a metadata tuple.
- [`UERC20MetadataLibrary.sol`](https://github.com/Uniswap/uerc20-factory/blob/de5bacd215f6aae50e524297c18fcf78b69b6312/src/libraries/UERC20MetadataLibrary.sol)
  fixes the tuple order as `description`, `website`, `image`, `extraData`.
- [`UERC20Factory.sol`](https://github.com/Uniswap/uerc20-factory/blob/de5bacd215f6aae50e524297c18fcf78b69b6312/src/factories/UERC20Factory.sol)
  emits this event after creating the token.

The signature is `TokenCreated(address,(string,string,string,bytes))`, topic0
`0x4ef8284ecf42d4cd19686572ffd87f630858c82398911e776cb831de35eddbf4`.
The tuple does not contain the token name or symbol. Those still come from
historical ERC-20 calls at the catalog cutoff. The launcher separately emits
`TokenCreated(address indexed tokenAddress)`; it is not this metadata source.

The committed [PROLOGUE proof](../data/registry/prologue-candidate-proof.json)
includes the actual factory event in successful launch transaction
`0x421c9f5b02412645661089c4857003a6e7a6a0c55a390a447079494096077bed`, block 38994659. Its single topic and encoded fields match the pinned ABI, including
an `ipfs://` image. The unit suite replays this receipt, rather than relying
only on a synthetic ABI round-trip. This confirms the observed emitter and
event layout; it is not a claim of independently reproducing deployed bytecode.

## Association and failure behavior

The log request uses the 12 verified Instant strategy addresses plus the
factory address, with both event signatures as topic0 alternatives. Address
and topic alternatives form a cross product, so the collector filters each
emitter/signature pair before decoding. A factory-created token alone does
not establish Pools membership or enter the catalog. CCA factory transactions
are not decoded as Instant launches.

Only factory events in verified launch transactions are considered for
enrichment. Their block/hash, transaction hash, log index, emitter, topics and
data must match the successful canonical launch receipt. The decoded token
must also match the exact launched token. Evidence disagreement aborts the
batch without advancing coverage. A second matching metadata event makes the
presentation fields ambiguous and unavailable; no arbitrary winner is chosen.

`evidence.logs` remains the launch log array for existing consumers.
`evidence.tokenMetadataLogs` contains matching-transaction factory rows with
verified receipt evidence, including malformed or unmatched-token rows.
`evidence.tokenMetadataIssues` records bounded reason codes with transaction
hash and log index. Malformed metadata is omitted without dropping an otherwise
valid launch. Legacy launches without the richer event remain supported.

## Presentation boundary

`CatalogPool` adds optional `imageUrl`, `description`, and `externalUrl`.
Blank, malformed and rejected values stay absent. The decoder caps encoded
event data at 64 KiB before decoding, checks canonical ABI re-encoding, removes
NUL/control/bidi formatting characters from descriptions, and limits descriptions
to 4,000 Unicode code points. URLs are capped at 2,048 JavaScript characters and
must parse with an HTTP, HTTPS, IPFS or IPNS scheme, nonempty host, no credentials
and no control/whitespace characters. Rejected values and changed descriptions
have explicit reason codes. `extraData` stays opaque in the raw evidence and
is never used to claim verified social identity.

These are still creator-supplied claims. Acceptance into the catalog does not
authorize network requests or establish safe image content. This collector
never fetches or hotlinks the supplied URLs. The separate serving path must
validate hosts, resolved addresses, redirects, size and content type before
caching or displaying image bytes, and keep the generated fallback.

## Observed image availability

On September 15, 2026, the 10 committed proof files (PROLOGUE, omitted-launch,
baseline-launch and seven files under `data/registry/candidate-proofs`) contained
10 distinct launched pool IDs. All 10 had a matching factory event and a
nonempty image URL accepted by this decoder. One external website value was
rejected; its image remained accepted. No image bytes were fetched.

This is a selected set of previously investigated launches, not a random sample
or a measurement of the 52,404-pool target. The market-wide image fraction is
unknown until discovery and its metadata projection cover that population.
