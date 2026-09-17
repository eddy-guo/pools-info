import type { Hex } from "viem";
import { RpcCallError, multicallPolicy, type TokenSupply } from "@pools/chain";
import type { TokenSupplyRow, UnreadTokenSupply } from "@pools/db";

/** The catalog's token supplies for FDV (`pnpm supply:read`): `totalSupply()`
 * of every token without one, in Multicall3 aggregates over the public RPC,
 * each stored with the block it was read at. Resumable: a run pages over the
 * unread pools, so a stopped run continues where it ended and a later run
 * picks up new launches. Never Alchemy, never a chain sweep. */
export const tokenSupplyPolicy = Object.freeze({
  publicRpcUrl: "https://rpc.mainnet.chain.robinhood.com",
  /** One aggregate per HTTP request, paced so the public RPC is not hammered. */
  minIntervalMs: 1000,
  /** The public RPC serves state only for its last few thousand blocks. */
  headEveryPages: 20,
  maxRequests: 500,
});
export interface TokenSupplyConfig {
  rpcUrl: string;
  minIntervalMs: number;
  maxRequests: number;
}
function integer(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
  min: number,
  max: number,
) {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < min || n > max)
    throw Error(`Invalid ${name}`);
  return n;
}
export function tokenSupplyConfig(
  env: Record<string, string | undefined> = process.env,
): TokenSupplyConfig {
  const rpcUrl =
    env.ROBINHOOD_RPC_URL?.trim() || tokenSupplyPolicy.publicRpcUrl;
  let host: string;
  try {
    host = new URL(rpcUrl).hostname;
  } catch {
    throw Error("Invalid ROBINHOOD_RPC_URL");
  }
  if (/alchemy/i.test(host))
    throw Error(
      "ROBINHOOD_RPC_URL must be the public RPC; the supply read never reads Alchemy",
    );
  return {
    rpcUrl,
    minIntervalMs: integer(
      env,
      "TOKEN_SUPPLY_MIN_INTERVAL_MS",
      tokenSupplyPolicy.minIntervalMs,
      250,
      60000,
    ),
    maxRequests: integer(
      env,
      "TOKEN_SUPPLY_MAX_REQUESTS",
      tokenSupplyPolicy.maxRequests,
      1,
      10000,
    ),
  };
}

export interface TokenSupplyDeps {
  unread(afterPoolRef: number, limit: number): Promise<UnreadTokenSupply[]>;
  save(rows: TokenSupplyRow[]): Promise<number>;
  head(): Promise<number>;
  /** Must answer from Multicall3 aggregates; `aggregated` false stops the run
   * before it falls back to one request per token. An `RpcCallError` means a
   * member's call failed on its own re-read. */
  read(
    tokens: Hex[],
    block: number,
  ): Promise<{ supplies: TokenSupply[]; aggregated: boolean }>;
  requests(): number;
  log(event: Record<string, unknown>): void;
  signal?: AbortSignal;
}
export interface TokenSupplySummary {
  pools: number;
  tokens: number;
  saved: number;
  unreadable: Hex[];
  aggregates: number;
  heads: number;
  requests: number;
  firstBlock: number | null;
  lastBlock: number | null;
  elapsedMs: number;
}
export async function runTokenSupplyRead(
  deps: TokenSupplyDeps,
): Promise<TokenSupplySummary> {
  const started = performance.now();
  const summary: TokenSupplySummary = {
    pools: 0,
    tokens: 0,
    saved: 0,
    unreadable: [],
    aggregates: 0,
    heads: 0,
    requests: 0,
    firstBlock: null,
    lastBlock: null,
    elapsedMs: 0,
  };
  let after = 0;
  let block = 0;
  let pages = 0;
  // A member whose call reverts fails its aggregate's individual re-read, so a
  // failed read is halved until the reverting token stands alone; it is left
  // unread and the rest of the page is kept, rather than stopping every run at
  // the same page.
  const readPage = async (tokens: Hex[]): Promise<TokenSupply[]> => {
    let result: Awaited<ReturnType<TokenSupplyDeps["read"]>>;
    try {
      result = await deps.read(tokens, block);
    } catch (error) {
      if (!(error instanceof RpcCallError)) throw error;
      if (tokens.length === 1)
        return [{ token: tokens[0], supplyRaw: null, block }];
      const half = Math.ceil(tokens.length / 2);
      return [
        ...(await readPage(tokens.slice(0, half))),
        ...(await readPage(tokens.slice(half))),
      ];
    }
    if (!result.aggregated)
      throw Error(
        "Multicall3 aggregate unavailable; refusing one request per token",
      );
    summary.aggregates++;
    return result.supplies;
  };
  for (;;) {
    deps.signal?.throwIfAborted();
    const page = await deps.unread(after, multicallPolicy.maxCalls);
    if (!page.length) break;
    after = page.at(-1)!.poolRef;
    const tokens = [...new Set(page.map((p) => p.token as Hex))];
    if (pages % tokenSupplyPolicy.headEveryPages === 0) {
      block = await deps.head();
      summary.heads++;
    }
    const supplies = await readPage(tokens);
    pages++;
    summary.pools += page.length;
    summary.tokens += tokens.length;
    const rows: TokenSupplyRow[] = [];
    for (const s of supplies)
      if (s.supplyRaw === null) summary.unreadable.push(s.token);
      else
        rows.push({ token: s.token, supplyRaw: s.supplyRaw, block: s.block });
    summary.saved += await deps.save(rows);
    summary.firstBlock ??= block;
    summary.lastBlock = block;
    if (pages % tokenSupplyPolicy.headEveryPages === 0)
      deps.log({
        event: "token_supply_progress",
        pools: summary.pools,
        saved: summary.saved,
        unreadable: summary.unreadable.length,
        block,
        requests: deps.requests(),
        elapsedMs: Math.round(performance.now() - started),
      });
  }
  summary.requests = deps.requests();
  summary.elapsedMs = Math.round(performance.now() - started);
  return summary;
}
