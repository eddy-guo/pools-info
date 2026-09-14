const sqlStates = new Set([
  "23502",
  "23503",
  "23505",
  "23514",
  "40001",
  "40P01",
  "57014",
  "42501",
  "25006",
  "42P01",
  "28P01",
  "53300",
  "53400",
  "57P01",
  "08000",
  "08001",
  "08003",
  "08006",
]);
const networkCodes = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "ECONNRESET",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);
const errorTypes = new Set([
  "Error",
  "TypeError",
  "SyntaxError",
  "RangeError",
  "AbortError",
  "TimeoutError",
  "error",
]);
/** Exposes only an allowlisted class/code, never raw provider/SQL text, URLs,
 * connection strings, causes, stack traces or user-controlled error names. */
export function errorDetails(e: unknown) {
  const value =
    e && typeof e === "object"
      ? (e as { name?: unknown; code?: unknown; cause?: { code?: unknown } })
      : {};
  const code = typeof value.code === "string" ? value.code : "";
  const causeCode =
    typeof value.cause?.code === "string" ? value.cause.code : "";
  return {
    errorType:
      typeof value.name === "string" && errorTypes.has(value.name)
        ? value.name
        : "unclassified",
    sqlState: sqlStates.has(code) ? code : null,
    networkCode: networkCodes.has(code)
      ? code
      : networkCodes.has(causeCode)
        ? causeCode
        : null,
  };
}

export function safeError(e: unknown) {
  // Return our own descriptions, never arbitrary provider, SQL or fetch text.
  const message = e instanceof Error ? e.message : "";
  if (
    /^Invalid INDEXER_(START_BLOCK|BATCH_BLOCKS|POLL_MS|POOLS_PER_CYCLE|LOG_RANGE_BLOCKS)$/.test(
      message,
    )
  )
    return `configuration_invalid: ${message}`;
  const details = errorDetails(e);
  if (details.networkCode)
    return `network_failed: ${details.networkCode}; retry the provider connection`;
  if (
    details.errorType === "TimeoutError" ||
    details.errorType === "AbortError"
  )
    return "rpc_timeout: retry the bounded request";
  const categories: [RegExp, string][] = [
    [
      /^RPC response ID mismatch$/,
      "rpc_response_id_mismatch: provider returned a different request ID",
    ],
    [
      /^Incomplete RPC batch$/,
      "rpc_batch_incomplete: provider omitted one or more batch replies",
    ],
    [
      /^(Duplicate RPC batch IDs|Missing RPC batch ID)$/,
      "rpc_batch_ids_invalid: provider returned duplicate or missing request IDs",
    ],
    [
      /^(Invalid RPC log result|Out-of-range log batch|Noncanonical\/out-of-range log|Conflicting duplicate log)$/,
      "rpc_log_evidence_invalid: provider log results failed validation",
    ],
    [
      /^RPC retry exhausted$/,
      "rpc_retries_exhausted: provider could not complete the bounded request",
    ],

    [
      /^fetch failed$/,
      "network_failed: provider request failed before a valid response",
    ],
    [
      /^RPC HTTP 400$/,
      "rpc_request_rejected: check provider request and range limits",
    ],
    [
      /^RPC HTTP (401|403)$/,
      "rpc_access_denied: check provider access and endpoint policy",
    ],
    [/^RPC HTTP 429$/, "rpc_unavailable: check provider capacity and retry"],
    [
      /^RPC HTTP 4[0-9]{2}$/,
      "rpc_request_rejected: check provider endpoint and limits",
    ],
    [
      /^RPC returned invalid JSON$/,
      "rpc_response_invalid: provider returned malformed JSON",
    ],
    [
      /^DATABASE_URL is required$/,
      "database_configuration_missing: set DATABASE_URL",
    ],
    [
      /^ROBINHOOD_RPC_URL is required for the persistent worker$/,
      "rpc_configuration_missing: set ROBINHOOD_RPC_URL",
    ],
    [
      /^INDEXER_START_BLOCK differs from saved start;/,
      "start_block_changed: restore the original INDEXER_START_BLOCK",
    ],
    [
      /^Another worker holds the writer lock$/,
      "writer_busy: keep one indexer replica",
    ],
    [/^Wrong chain$/, "wrong_chain: configure Robinhood chain 4663 RPC"],
    [
      /^(Invalid chain head|Missing canonical header|Missing or invalid event header|Missing header)$/,
      "invalid_header: check the RPC endpoint and retry",
    ],
    [
      /^(Checkpoint parent changed|Discovery boundary changed|Pool boundary changed|Cutoff changed during (event )?collection)$/,
      "chain_changed: retry and reconcile the saved checkpoint",
    ],
    [
      /^Collection budget exceeded after [0-9]+ HTTP requests and [0-9]+ RPC calls$/,
      "rpc_budget_exceeded: reduce INDEXER_BATCH_BLOCKS or check RPC capacity",
    ],
    [
      /^(Event batch exceeds 10000 logs;|Catalog batch exceeds 250 launches;)/,
      "batch_too_large: reduce INDEXER_BATCH_BLOCKS",
    ],
    [
      /^(RPC HTTP (429|5[0-9]{2})|RPC returned an error or missing result)$/,
      "rpc_unavailable: check provider capacity and retry",
    ],
    [
      /^(Unexpected event source or range|Unexpected launch source|Unsupported or inconsistent PoolKey|Unverified catalog launch|Inconsistent event receipt or canonical block|Missing or invalid event receipt|Duplicate event evidence)$/,
      "evidence_rejected: inspect contract registry and RPC evidence before resuming",
    ],
    [
      /^(Conflicting replay|Stale checkpoint or noncontiguous batch|Stale rewind|Unknown ancestor)$/,
      "checkpoint_conflict: stop duplicate writers and inspect saved coverage",
    ],
    [
      /^Applied migration changed;/,
      "migration_changed: restore the applied migration and add a new one",
    ],
  ];
  for (const [pattern, description] of categories)
    if (pattern.test(message)) return description;
  if (e && typeof e === "object" && "code" in e) {
    if (["23502", "23503", "23505", "23514"].includes(String(e.code)))
      return `database_constraint_failed: ${e.code}; inspect saved batch identity`;
    if (["40001", "40P01"].includes(String(e.code)))
      return `database_transaction_retry: ${e.code}`;
    if (e.code === "57014")
      return "database_timeout: query exceeded the database budget";
    if (e.code === "42501" || e.code === "25006")
      return "database_permission_denied: check the collector database role";
    if (e.code === "42P01") return "schema_missing: run indexer migrations";
    if (e.code === "28P01")
      return "database_authentication_failed: check DATABASE_URL credentials";
    if (e.code === "ECONNREFUSED" || e.code === "ENOTFOUND")
      return "connection_failed: check database and RPC connectivity";
  }
  return "operation_failed: saved checkpoint preserved; inspect configuration and retry";
}
