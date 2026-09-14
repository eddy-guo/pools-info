import { mkdir, rename, writeFile } from "node:fs/promises";
import {
  decodeEventLog,
  decodeFunctionResult,
  encodeFunctionData,
  erc20Abi,
  toEventSelector,
  type Hex,
} from "viem";
import {
  contracts,
  decodeLaunch,
  decodeSwap,
  launchEvent,
  swapEvent,
  transferEvent,
  spotPriceWei,
  type RawLog,
} from "./chain/events";
import { Rpc, hex } from "./chain/rpc";
import type {
  ChainMarket,
  ChainSnapshot,
  ChainTrade,
} from "../packages/core/src/chain-types";

// This exporter is opt-in. Normal web builds never depend on a live provider.
async function main() {
  const started = Date.now();
  const rpc = new Rpc();
  const span = Number(process.env.CHAIN_BLOCK_SPAN ?? 100000);
  const poolLimit = Number(process.env.CHAIN_POOL_LIMIT ?? 8);
  if (
    !Number.isSafeInteger(span) ||
    span < 1 ||
    span > 1000000 ||
    !Number.isSafeInteger(poolLimit) ||
    poolLimit < 1 ||
    poolLimit > 30
  )
    throw Error("Invalid bounded scan settings");
  if (Number(await rpc.call<Hex>("eth_chainId", [])) !== 4663)
    throw Error("Wrong chain");
  const head = Number(await rpc.call<Hex>("eth_blockNumber", []));
  // A 128-block lag reduces head churn; it does not claim L1 finality.
  const toBlock = head - 128;
  const fromBlock = Math.max(0, toBlock - span + 1);
  type Block = { hash: Hex; timestamp: Hex; number: Hex };
  const blockCache = new Map<number, Block>();
  async function block(n: number) {
    let value = blockCache.get(n);
    if (!value) {
      value = await rpc.call<Block>("eth_getBlockByNumber", [hex(n), false]);
      if (!value || Number(value.number) !== n) throw Error("Missing block");
      blockCache.set(n, value);
    }
    return value;
  }
  const cutoff = await block(toBlock);
  for (const address of [
    contracts.manager,
    contracts.launcher,
    ...contracts.strategies,
  ]) {
    if ((await rpc.call<Hex>("eth_getCode", [address, hex(toBlock)])) === "0x")
      throw Error("Missing deployed contract");
  }
  const launches = await rpc.logs(
    contracts.strategies,
    [toEventSelector(launchEvent)],
    fromBlock,
    toBlock,
  );
  const selected = launches.slice(-poolLimit).reverse();
  if (!selected.length)
    throw Error("No launches found; keeping previous snapshot");
  const markets: ChainMarket[] = [];
  const trades: ChainTrade[] = [];
  const evidence: {
    launches: RawLog[];
    swaps: RawLog[];
    receipts: unknown[];
    blocks?: Block[];
  } = { launches, swaps: [], receipts: [] };
  let reconciliation: ChainSnapshot["reconciliation"] = null;
  type Receipt = {
    status: Hex;
    from: Hex;
    to: Hex;
    blockHash: Hex;
    logs: RawLog[];
    transactionHash: Hex;
  };
  for (const log of selected) {
    const launch = decodeLaunch(log);
    const launchBlock = Number(log.blockNumber);
    const header = await block(launchBlock);
    if (header.hash !== log.blockHash) throw Error("Launch block changed");
    const receipt = await rpc.call<Receipt>("eth_getTransactionReceipt", [
      log.transactionHash,
    ]);
    if (
      receipt.status !== "0x1" ||
      receipt.blockHash !== log.blockHash ||
      !receipt.logs.some((l) => l.address.toLowerCase() === contracts.launcher)
    )
      throw Error("Unverified launch receipt");
    evidence.receipts.push(receipt);
    async function tokenRead(
      name: "name" | "symbol" | "decimals" | "totalSupply",
    ) {
      const data = await rpc.call<Hex>("eth_call", [
        {
          to: launch.token,
          data: encodeFunctionData({ abi: erc20Abi, functionName: name }),
        },
        hex(toBlock),
      ]);
      return decodeFunctionResult({ abi: erc20Abi, functionName: name, data });
    }
    const [name, symbol, decimals, supply] = await Promise.all([
      tokenRead("name"),
      tokenRead("symbol"),
      tokenRead("decimals"),
      tokenRead("totalSupply"),
    ]);
    const rawSwaps = await rpc.logs(
      contracts.manager,
      [toEventSelector(swapEvent), launch.poolId],
      launchBlock,
      toBlock,
    );
    evidence.swaps.push(...rawSwaps);
    const decoded = rawSwaps.map((l) => ({ log: l, args: decodeSwap(l) }));
    console.log(`Reading ${String(symbol)}: ${decoded.length} swaps`);
    if (decoded.length > 20000)
      throw Error("Pool exceeds bounded snapshot size; use bulk ingestion");
    const neededBlocks = [
      ...new Set(rawSwaps.map((l) => Number(l.blockNumber))),
    ];
    for (let i = 0; i < neededBlocks.length; i += 4) {
      await Promise.all(neededBlocks.slice(i, i + 4).map(block));
    }
    const series: ChainMarket["series"] = [];
    for (const s of decoded) {
      if (s.args.id !== launch.poolId) throw Error("Wrong pool returned");
      const b = await block(Number(s.log.blockNumber));
      if (b.hash !== s.log.blockHash) throw Error("Swap block changed");
      const timestamp = Number(b.timestamp);
      const price = spotPriceWei(s.args.sqrtPriceX96, Number(decimals));
      series.push({ time: timestamp, wei: price });
      trades.push({
        poolId: launch.poolId,
        txHash: s.log.transactionHash,
        logIndex: Number(s.log.logIndex),
        block: Number(s.log.blockNumber),
        timestamp,
        side: s.args.side,
        ethWei: s.args.ethWei,
        tokenRaw: s.args.tokenRaw,
      });
    }
    // Check the latest simple swap against the actual ERC20 movement to tx.from.
    // This is transaction-level evidence, not proof of wallet cost basis or ownership.
    if (!reconciliation && decoded.length) {
      const s = decoded.at(-1)!;
      const r = await rpc.call<Receipt>("eth_getTransactionReceipt", [
        s.log.transactionHash,
      ]);
      if (r.blockHash !== s.log.blockHash || r.status !== "0x1")
        throw Error("Swap receipt changed");
      evidence.receipts.push(r);
      let movement = 0n;
      for (const l of r.logs.filter(
        (l) =>
          l.address.toLowerCase() === launch.token.toLowerCase() &&
          l.topics[0] === toEventSelector(transferEvent),
      )) {
        const { args } = decodeEventLog({
          abi: [transferEvent],
          ...l,
          strict: true,
        });
        if (args.to.toLowerCase() === r.from.toLowerCase())
          movement += args.value;
        if (args.from.toLowerCase() === r.from.toLowerCase())
          movement -= args.value;
      }
      const samePoolSwaps = r.logs.filter(
        (l) =>
          l.address.toLowerCase() === contracts.manager &&
          l.topics[0] === toEventSelector(swapEvent) &&
          l.topics[1] === launch.poolId,
      );
      const delta = samePoolSwaps.reduce(
        (n, l) => n + decodeSwap(l).amount1,
        0n,
      );
      reconciliation = {
        txHash: s.log.transactionHash,
        wallet: r.from,
        token: launch.token,
        swapTokenDelta: delta.toString(),
        transferTokenDelta: movement.toString(),
        matches: movement === delta,
        scope:
          "Net token transfers to transaction sender versus all swap legs in this pool in one receipt. No PnL or all-time inventory claim.",
      };
    }
    markets.push({
      id: launch.poolId,
      token: launch.token,
      name: String(name).slice(0, 160),
      symbol: String(symbol).slice(0, 40),
      decimals: Number(decimals),
      supply: String(supply),
      launchBlock,
      launchedAt: Number(header.timestamp),
      launchTx: log.transactionHash,
      launchSender: receipt.from,
      positionRecipient: launch.finalPositionRecipient,
      strategy: log.address,
      creatorFees: log.address.toLowerCase() === contracts.strategies[0],
      fee: launch.key.fee,
      priceWei: series.at(-1)?.wei ?? null,
      volumeWei: decoded
        .reduce((n, s) => n + BigInt(s.args.ethWei), 0n)
        .toString(),
      swaps: decoded.length,
      buys: decoded.filter((s) => s.args.side === "buy").length,
      sells: decoded.filter((s) => s.args.side === "sell").length,
      series,
    });
    console.log(
      `${markets.length}/${selected.length} ${String(symbol)}: ${decoded.length} swaps`,
    );
  }
  const recheck = await rpc.call<Block>("eth_getBlockByNumber", [
    hex(toBlock),
    false,
  ]);
  if (recheck.hash !== cutoff.hash)
    throw Error("Chain reorganized during scan; previous snapshot retained");
  trades.sort((a, b) => b.block - a.block || b.logIndex - a.logIndex);
  const snapshot: ChainSnapshot = {
    schemaVersion: 1,
    chainId: 4663,
    generatedAt: new Date().toISOString(),
    fromBlock,
    toBlock,
    fromTimestamp: Number((await block(fromBlock)).timestamp),
    toTimestamp: Number(cutoff.timestamp),
    blockHash: cutoff.hash,
    discoveredLaunches: launches.length,
    markets,
    trades,
    reconciliation,
    requests: rpc.requests,
    durationMs: Date.now() - started,
  };
  await mkdir(".data/chain", { recursive: true });
  evidence.blocks = [...blockCache.values()];
  await writeFile(`.data/chain/${toBlock}.json`, JSON.stringify(evidence));
  await writeFile(
    "data/snapshots/chain.json.tmp",
    JSON.stringify(snapshot, null, 2) + "\n",
  );
  await rename("data/snapshots/chain.json.tmp", "data/snapshots/chain.json");
  console.log(
    JSON.stringify({
      pools: markets.length,
      swaps: trades.length,
      fromBlock,
      toBlock,
      requests: rpc.requests,
      seconds: Math.round(snapshot.durationMs / 1000),
      reconciled: reconciliation?.matches,
    }),
  );
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Snapshot failed");
  process.exitCode = 1;
});
