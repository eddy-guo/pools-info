import pg from "pg";
import { BlockscoutError, type BlockscoutClient } from "./blockscout-client";
import { ledgerLeaderboardPolicy } from "./ledger-leaderboard";

/** The trader board never ranks a contract (decided 28 Sep 2026; All-time
 * #29 of 27 Sep was a market-making contract many wallets call). The ledger
 * cannot tell one on its own: a deployed contract never sends a transaction,
 * so it never initiates a swap, but neither does a wallet whose trades are
 * all relayed, such as an EIP-7702 wallet with sponsored gas (30d and All
 * #33 of 27 Sep). So the census reads the code of exactly the wallets the
 * board could show that the ledger never saw initiate a swap, once each, and
 * `wallet_code_observations` keeps the answer, which the tip loop's ranking
 * and the board's reads apply (docs/LEDGER-MARKET-SERVING.md, "The trader
 * leaderboard"). */
export const contractCensusPolicy = Object.freeze({
  /** The first run after start, then one every interval. */
  firstRunMs: 30000,
  intervalMs: 300000,
  /** Addresses read per run and per UTC day: five to an explorer call of 20
   * credits, so at most 100 and 1,000 credits. A board holds a handful. */
  addressesPerRun: 25,
  addressesPerDay: 250,
  /** Never read while the key's stated balance is under this. */
  creditFloor: 30000,
  /** The wallet page's own reads keep the last fifth of the day's credits. */
  reserveShare: 0.2,
  /** A wallet with no code, or a delegated one, is read again after this
   * long while the board could still show it: an address can gain code. */
  recheckDays: 7,
});
export type ContractCensusPolicy = Record<
  keyof typeof contractCensusPolicy,
  number
>;
export type WalletCodeKind = "contract" | "delegated" | "none";
/** A contract is code that is not an EIP-7702 delegation designator
 * (`0xef0100` and the 20-byte delegate): a delegated account is still an
 * externally owned wallet. */
export function walletCodeKind(code: string): WalletCodeKind {
  if (!/^0x(?:[0-9a-f]{2})*$/i.test(code)) throw Error("Invalid code");
  if (code === "0x") return "none";
  return /^0xef0100[0-9a-f]{40}$/i.test(code) ? "delegated" : "contract";
}
export interface WalletCodeObservation {
  address: string;
  kind: WalletCodeKind;
  codeBytes: number;
}
export interface WalletCodeStore {
  /** The wallets the board could show whose code is due a read. */
  candidates(limit: number): Promise<string[]>;
  record(observations: readonly WalletCodeObservation[]): Promise<void>;
  close(): Promise<void>;
}

/** The board's candidates: every wallet in the top of each window by either
 * order at the default gate, a known contract never, that the ledger never
 * saw initiate a swap (every attributed swap of every position it holds
 * went to it as the transaction's counterparty), and whose code has not
 * been read, or was read as no contract more than `recheckDays` ago. */
const candidatesSql = (n: number, minTrades: number) => {
  const top = (
    column: string,
  ) => `SELECT x.wallet_ref FROM agg_trader_windows x JOIN agg_wallets w USING (wallet_ref)
      WHERE x.chain_id=4663 AND x."window"=v.name AND x.supported_trades>=${minTrades} AND x.supported_positions>0
        AND NOT EXISTS (SELECT 1 FROM wallet_code_observations c WHERE c.chain_id=4663 AND c.address=w.address AND c.kind='contract')
      ORDER BY x.${column} DESC,w.address LIMIT ${n}`;
  return `WITH top AS (
    SELECT DISTINCT t.wallet_ref FROM unnest(ARRAY['1h','6h','24h','7d','30d','All']) AS v(name)
    CROSS JOIN LATERAL (${top("realized_wei")}) t
    UNION
    SELECT DISTINCT t.wallet_ref FROM unnest(ARRAY['1h','6h','24h','7d','30d','All']) AS v(name)
    CROSS JOIN LATERAL (${top("net_wei")}) t
  )
  SELECT '0x'||encode(w.address,'hex') AS address FROM top JOIN agg_wallets w USING (wallet_ref)
  WHERE NOT EXISTS (SELECT 1 FROM agg_positions p WHERE p.chain_id=4663 AND p.wallet_ref=top.wallet_ref AND p.counterparty_swaps<p.buys+p.sells)
    AND NOT EXISTS (SELECT 1 FROM wallet_code_observations c WHERE c.chain_id=4663 AND c.address=w.address
      AND (c.kind='contract' OR c.observed_at>now()-interval '${contractCensusPolicy.recheckDays} days'))
  ORDER BY w.address LIMIT $1`;
};

/** The census's own small pool, as the token image store has one: the
 * reader's connections stay READ ONLY, and these two statements are the
 * only ones it runs. */
export function createWalletCodeStore(
  url = process.env.DATABASE_URL,
  testSchema?: string,
): WalletCodeStore {
  if (!url) throw Error("DATABASE_URL is required");
  if (testSchema && !/^api_test_[a-z0-9_]+$/.test(testSchema))
    throw Error("Invalid test schema");
  const pool = new pg.Pool({
    connectionString: url,
    max: 1,
    connectionTimeoutMillis: 2000,
    idleTimeoutMillis: 30000,
    statement_timeout: 3000,
    query_timeout: 4000,
    application_name: "pools-read-api-census",
    ...(testSchema ? { options: `-c search_path=${testSchema}` } : {}),
  });
  pool.on("error", () =>
    process.stderr.write('{"event":"idle_database_connection_error"}\n'),
  );
  return {
    async candidates(limit) {
      const { rows } = await pool.query(
        candidatesSql(
          ledgerLeaderboardPolicy.rankedWallets,
          ledgerLeaderboardPolicy.minTrades,
        ),
        [limit],
      );
      return rows.map((r) => r.address as string);
    },
    async record(observations) {
      if (!observations.length) return;
      await pool.query(
        `INSERT INTO wallet_code_observations(chain_id,address,kind,code_bytes,observed_at)
         SELECT 4663,decode(substr(a,3),'hex'),k,b,clock_timestamp() FROM unnest($1::text[],$2::text[],$3::int[]) AS o(a,k,b)
         ON CONFLICT (chain_id,address) DO UPDATE SET kind=EXCLUDED.kind,code_bytes=EXCLUDED.code_bytes,observed_at=EXCLUDED.observed_at`,
        [
          observations.map((o) => o.address),
          observations.map((o) => o.kind),
          observations.map((o) => o.codeBytes),
        ],
      );
    },
    close: () => pool.end(),
  };
}

export interface ContractCensusRun {
  /** Why nothing, or nothing more, was read. */
  stopped:
    | "done"
    | "not_configured"
    | "daily_cap"
    | "credit_floor"
    | "explorer_failed"
    | "database_failed";
  observed: WalletCodeObservation[];
}
/** One run reads the due candidates five to a call and records each batch
 * as it lands. Every stop is final for the run: a failed call is never
 * retried inside it, and the next run starts from what was recorded. */
export function createContractCensus({
  store,
  client,
  log = (event) => process.stdout.write(JSON.stringify(event) + "\n"),
  now = Date.now,
  policy = contractCensusPolicy,
}: {
  store: WalletCodeStore;
  client: BlockscoutClient | null;
  log?: (event: Record<string, unknown>) => void;
  now?: () => number;
  policy?: ContractCensusPolicy;
}) {
  let day = "",
    read = 0,
    timer: NodeJS.Timeout | null = null,
    running: Promise<ContractCensusRun> | null = null,
    closed = false;
  const belowFloor = () => {
    const remaining = client?.budget.snapshot().remaining ?? null;
    return remaining !== null && remaining < policy.creditFloor;
  };
  async function census(): Promise<ContractCensusRun> {
    const observed: WalletCodeObservation[] = [];
    if (!client) return { stopped: "not_configured", observed };
    const today = new Date(now()).toISOString().slice(0, 10);
    if (today !== day) {
      day = today;
      read = 0;
    }
    const allowance = Math.min(
      policy.addressesPerRun,
      policy.addressesPerDay - read,
    );
    if (allowance <= 0) return { stopped: "daily_cap", observed };
    if (belowFloor()) return { stopped: "credit_floor", observed };
    let due: string[];
    try {
      due = await store.candidates(allowance);
    } catch {
      return { stopped: "database_failed", observed };
    }
    for (let i = 0; i < due.length; i += 5) {
      if (belowFloor()) return { stopped: "credit_floor", observed };
      const batch = due.slice(i, i + 5);
      read += batch.length;
      let code: Map<string, string>;
      try {
        code = await client.readCode(batch, policy.reserveShare);
      } catch (error) {
        if (!(error instanceof BlockscoutError)) throw error;
        return {
          stopped:
            error.kind === "budget_exhausted"
              ? "credit_floor"
              : "explorer_failed",
          observed,
        };
      }
      const answers = batch.map((address) => {
        const c = code.get(address)!;
        return {
          address,
          kind: walletCodeKind(c),
          codeBytes: (c.length - 2) / 2,
        };
      });
      try {
        await store.record(answers);
      } catch {
        return { stopped: "database_failed", observed };
      }
      observed.push(...answers);
    }
    return { stopped: "done", observed };
  }
  function run() {
    running ??= census()
      .then((result) => {
        if (result.observed.length || result.stopped !== "done")
          log({
            event: "contract_census",
            stopped: result.stopped,
            contracts: result.observed
              .filter((o) => o.kind === "contract")
              .map((o) => o.address),
            read: result.observed.length,
          });
        return result;
      })
      .finally(() => {
        running = null;
      });
    return running;
  }
  function schedule(ms: number) {
    if (closed) return;
    timer = setTimeout(() => {
      void run()
        .catch((error: unknown) =>
          log({
            event: "contract_census_failed",
            error: error instanceof Error ? error.name : "unknown",
          }),
        )
        .finally(() => schedule(policy.intervalMs));
    }, ms);
    timer.unref();
  }
  return {
    run,
    start() {
      if (!timer && !closed) schedule(policy.firstRunMs);
    },
    async close() {
      closed = true;
      if (timer) clearTimeout(timer);
      await running?.catch(() => undefined);
      await store.close();
    },
  };
}
