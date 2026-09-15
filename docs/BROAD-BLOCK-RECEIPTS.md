# Optional broad block receipts

`INDEXER_BROAD_RECEIPT_MODE` defaults to `transaction`. With the broad worker
explicitly enabled, `block` selects `eth_getBlockReceipts` for canonical blocks
containing selected registered swaps. Other values fail configuration validation;
a disabled broad scheduler does not validate this option or construct an RPC.
This option does not enable broad indexing by itself.

The collector groups selected transaction identities by block, validates each
returned block receipt list, discards unrelated receipts, and retains selected
receipts in the same sorted transaction-hash order as transaction mode. It checks
receipt counts, unique transaction hashes, canonical block number/hash and receipt
status/log structure before selection. Selected receipts additionally pass all
existing sender, successful-status, source and exact-log identity checks. Missing,
duplicate, wrong-block or inconsistent selected evidence rejects the whole group.
Failed unrelated transactions are allowed. Empty or unregistered ranges fetch no
receipts.

The RPC transport enforces at most two block calls per HTTP batch, including
retries, regardless of the ordinary RPC batch setting. Existing minimum interval,
total time/request budgets and sticky HTTP/JSON 429 guards remain in effect. Two
is a per-client batch ceiling, not an account-wide throughput guarantee. Provider
capability and account-wide headroom require validation before activation.

Each block-receipt HTTP response, including its JSON-RPC envelope and unrelated
receipt data, is capped at 8 MiB of streamed body bytes before JSON parsing. The
reader cancels on overflow; an oversized declared Content-Length also rejects
immediately. Each block list is capped at 2,000 receipts. Selected retained data
still obeys the existing 16 MiB whole-group budget. Body-byte overflow is terminal
for that collection, with no transport retry or automatic switch of receipt mode.
HTTP 429 cancels its body immediately and follows throttling handling even if the
body is oversized. Operation cancellation aborts fetches and transport waits.
Body/count capacity overflow follows the existing worker policy: defer a smaller
whole range until the next main cycle, and stop on an oversized single block.
All failures occur before broad commit and preserve the uncommitted cursor.

Transport mode and unrelated receipts are absent from saved evidence. The group
schema, content hash and migrations are unchanged. Exact replay continues to use
the retained selected receipts through the transaction-receipt evidence adapter,
without requiring block-receipt responses or network calls. Only operational
request counts differ between modes. `methodCountsBeforeRetries` reports
`eth_getBlockReceipts` separately from `eth_getTransactionReceipt`; these logical
counts do not measure provider billing or throughput units.

Mock transport and isolated Postgres tests cover identical groups across multiple
pools/transactions/blocks, replay with fetch disabled, reply ordering, body and
receipt-count overflow, missing/duplicate/wrong-block evidence, cancellation,
canonical changes, sticky HTTP 429 and partial JSON 429 retry. No live RPC call or
production setting change is needed to run these tests.
