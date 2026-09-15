# RPC rate-limit stop

All three indexer processes emit `rpc_rate_limited` for every HTTP 429 or
JSON-RPC code 429, including responses recovered by the existing retry path.
Logs contain a worker name, fixed method labels, batch sizes and counters.
They never contain an RPC URL, request parameters or provider error text.

Four throttled attempts for the same logical RPC call raise a terminal
`RpcRateLimitExhausted`. No fresh batch, smaller range, pool fallback or analytics
retry may restart that operation. The client also rejects further requests.
Other failures keep their existing retry behavior.

The affected worker exits with reserved code 75. The service logs
`service_paused_rpc_rate_limit`, sends SIGTERM to its siblings and retains the
existing 20-second forced-shutdown bound. The service exits with code 0.
The checked-in Railway configuration uses `ON_FAILURE`, so this clean exit
requires a manual restart instead of automatically launching another sweep.
Do not change that policy to `ALWAYS` without revising this stop mechanism.

A rate-limit pause is sticky within the worker process: even if database
cleanup fails, the supervisor still receives the reserved pause code.
Already-running sibling operations may drain before shutdown. Saved cursors
are not reset, and successful atomic batches remain resumable.

Before restarting, inspect the reported rate-limit events and provider
capacity, then explicitly restart the service after the cause is addressed.
No credentials, billing settings, database schema or runtime configuration
are changed by this guard.

During discovery v2 catch-up, the main worker prioritizes discovery and leaves
deep pool cursors untouched. Deep work resumes after catch-up or when v2 is
disabled. Discovery failures back off instead of starting deep work; the
recent and analytics processes remain independently scheduled. The startup
`worker_rpc_configuration` event records the configured log-range size,
minimum request interval and maximum JSON-RPC batch size without credentials.
