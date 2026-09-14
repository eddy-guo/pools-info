# Verified analytics seed

`pepe-capture.json.gz` contains a generated Robinhood Chain snapshot and the raw launch, swap, transfer, receipt and block evidence used to produce it. The cutoff is block 62,693,798, not the current chain head. It is public chain data; no RPC credentials are included.

The analytics worker reconstructs accounting and holders from this evidence, checks canonical hashes and archival state using its configured RPC, then stores the result in Postgres. It does not trust supplied PnL. Equal or newer published cutoffs are preserved on restart. The seed provides a useful initial sample while the persistent collector covers more history.

This evidence is copied only into the Railway worker image. The web frontend receives the smaller derived snapshot in `data/pools/index.json` as its labeled offline fallback.
