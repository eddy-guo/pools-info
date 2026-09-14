import {
  decodeEventLog,
  decodeFunctionResult,
  encodeFunctionData,
  erc20Abi,
  toEventSelector,
  parseAbiItem,
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
} from "./events";
import { Rpc, hex } from "./rpc";
import { auditPool, type Receipt } from "./audit";
import type { ChainMarket, ChainSnapshot, ChainTrade } from "@pools/core";

// This exporter is opt-in. Normal web builds never depend on a live provider.
export async function collectSnapshot(
  options: {
    span?: number;
    poolLimit?: number;
    rpc?: Rpc;
    onProgress?: (message: string) => void;
    includeAccounting?: boolean;
    target?: { poolId: string; launchTx: Hex };
  } = {},
) {
  const started = Date.now();
  const rpc = options.rpc ?? new Rpc();
  const span = options.span ?? 100000;
  const poolLimit = options.poolLimit ?? 8;
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
  if (!Number.isSafeInteger(head) || head < 128)
    throw Error("Invalid chain head");
  // A 128-block lag reduces head churn; it does not claim L1 finality.
  const toBlock = head - 128;
  let fromBlock = Math.max(0, toBlock - span + 1);
  type Block = { number: Hex; timestamp: Hex; hash: Hex };
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

  const deployments = [
    contracts.manager,
    contracts.launcher,
    ...contracts.strategies,
  ];
  const deploymentCode = await rpc.batch<Hex>(
    "eth_getCode",
    deployments.map((address) => [address, hex(toBlock)]),
  );
  if (deploymentCode.some((code) => code === "0x"))
    throw Error("Missing deployed contract");
  const launches = options.target
    ? (
        await rpc.call<Receipt>("eth_getTransactionReceipt", [
          options.target.launchTx,
        ])
      ).logs.filter(
        (l) =>
          contracts.strategies.some((a) => a === l.address.toLowerCase()) &&
          l.topics[0] === toEventSelector(launchEvent) &&
          l.topics[1] === options.target!.poolId,
      )
    : await rpc.logs(
        contracts.strategies,
        [toEventSelector(launchEvent)],
        fromBlock,
        toBlock,
      );
  if (options.target && launches.length !== 1) throw Error("Unknown launch");
  if (options.target) {
    const first = Number(launches[0].blockNumber);
    if (first > toBlock || toBlock - first > 1000000)
      throw Error("Pool outside bounded audit window");
    fromBlock = Math.min(fromBlock, first);
  }
  const selected = launches.slice(-poolLimit).reverse();
  if (!selected.length)
    throw Error("No launches found; keeping previous snapshot");
  const markets: ChainMarket[] = [];
  const trades: ChainTrade[] = [];
  const evidence: {
    launches: RawLog[];
    swaps: RawLog[];
    transfers: RawLog[];
    receipts: unknown[];
    blocks?: Block[];
  } = { launches, swaps: [], transfers: [], receipts: [] };
  let reconciliation: ChainSnapshot["reconciliation"] = null;
  const receiptCache = new Map<Hex, Promise<Receipt>>();
  const codeCache = new Map<Hex, Promise<Hex>>();
  function getReceipt(hash: Hex) {
    let pending = receiptCache.get(hash);
    if (!pending) {
      pending = rpc
        .call<Receipt>("eth_getTransactionReceipt", [hash])
        .then((receipt) => {
          if (!receipt) throw Error("Missing receipt");
          evidence.receipts.push(receipt);
          return receipt;
        });
      receiptCache.set(hash, pending);
    }
    return pending;
  }
  function code(address: Hex) {
    let pending = codeCache.get(address);
    if (!pending) {
      pending = rpc.call<Hex>("eth_getCode", [address, hex(toBlock)]);
      codeCache.set(address, pending);
    }
    return pending;
  }
  for (const log of selected) {
    const launch = decodeLaunch(log);
    const launchBlock = Number(log.blockNumber);
    const header = await block(launchBlock);
    if (header.hash !== log.blockHash) throw Error("Launch block changed");
    const receipt = await getReceipt(log.transactionHash);
    if (
      receipt.status !== "0x1" ||
      receipt.blockHash !== log.blockHash ||
      !receipt.logs.some(
        (l) =>
          l.logIndex === log.logIndex &&
          l.address.toLowerCase() === log.address.toLowerCase() &&
          l.data.toLowerCase() === log.data.toLowerCase() &&
          l.topics.join().toLowerCase() === log.topics.join().toLowerCase(),
      ) ||
      !receipt.logs.some((l) => l.address.toLowerCase() === contracts.launcher)
    )
      throw Error("Unverified launch receipt");
    const metadataFields = [
      "name",
      "symbol",
      "decimals",
      "totalSupply",
    ] as const;
    const metadataResults = await rpc.batch<Hex>(
      "eth_call",
      metadataFields.map((functionName) => [
        {
          to: launch.token,
          data: encodeFunctionData({ abi: erc20Abi, functionName }),
        },
        hex(toBlock),
      ]),
    );
    const [name, symbol, decimals, supply] = metadataResults.map((data, i) =>
      decodeFunctionResult({
        abi: erc20Abi,
        functionName: metadataFields[i],
        data,
      }),
    );
    const rawSwaps = await rpc.logs(
      contracts.manager,
      [toEventSelector(swapEvent), launch.poolId],
      launchBlock,
      toBlock,
    );
    evidence.swaps.push(...rawSwaps);
    const transfers = options.includeAccounting
      ? await rpc.logs(
          launch.token,
          [toEventSelector(transferEvent)],
          launchBlock,
          toBlock,
        )
      : [];
    evidence.transfers.push(...transfers);
    const decoded = rawSwaps.map((l) => ({ log: l, args: decodeSwap(l) }));
    options.onProgress?.(`Reading ${String(symbol)}: ${decoded.length} swaps`);
    if (decoded.length > 4000)
      throw Error("Pool exceeds bounded snapshot size; use bulk ingestion");
    const neededBlocks = [
      ...new Set([...rawSwaps, ...transfers].map((l) => Number(l.blockNumber))),
    ];
    const uncached = neededBlocks.filter((n) => !blockCache.has(n));
    const headers = await rpc.batch<Block>(
      "eth_getBlockByNumber",
      uncached.map((n) => [hex(n), false]),
    );
    headers.forEach((header, i) => {
      if (!header || Number(header.number) !== uncached[i])
        throw Error("Missing or mismatched block header");
      blockCache.set(uncached[i], header);
    });
    if (options.includeAccounting) {
      const hashes = [
        ...new Set(rawSwaps.map((l) => l.transactionHash)),
      ].filter((hash) => !receiptCache.has(hash));
      const receipts = await rpc.batch<Receipt>(
        "eth_getTransactionReceipt",
        hashes.map((hash) => [hash]),
      );
      receipts.forEach((receipt, i) => {
        if (!receipt || receipt.transactionHash !== hashes[i])
          throw Error("Missing or mismatched receipt");
        receiptCache.set(hashes[i], Promise.resolve(receipt));
        evidence.receipts.push(receipt);
      });
      const senders = [
        ...new Set(
          (
            await Promise.all(
              rawSwaps.map((l) => getReceipt(l.transactionHash)),
            )
          ).map((r) => r.from),
        ),
      ].filter((sender) => !codeCache.has(sender));
      const codes = await rpc.batch<Hex>(
        "eth_getCode",
        senders.map((sender) => [sender, hex(toBlock)]),
      );
      codes.forEach((value, i) =>
        codeCache.set(senders[i], Promise.resolve(value)),
      );
    }
    for (const transfer of transfers) {
      if (
        transfer.address.toLowerCase() !== launch.token.toLowerCase() ||
        (await block(Number(transfer.blockNumber))).hash !== transfer.blockHash
      )
        throw Error("Transfer block changed");
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
      const r = await getReceipt(s.log.transactionHash);
      if (r.blockHash !== s.log.blockHash || r.status !== "0x1")
        throw Error("Swap receipt changed");
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
    const tokenBornAtLaunch = receipt.logs.some(
      (l) =>
        l.address.toLowerCase() === contracts.launcher &&
        l.topics[0] ===
          toEventSelector(
            parseAbiItem("event TokenCreated(address indexed tokenAddress)"),
          ) &&
        l.topics[1] ===
          `0x${launch.token.toLowerCase().slice(2).padStart(64, "0")}`,
    );
    const accounting = options.includeAccounting
      ? await auditPool({
          rpc,
          token: launch.token,
          rawSwaps,
          transfers,
          trades: trades.filter((t) => t.poolId === launch.poolId),
          toBlock,
          tokenBornAtLaunch,
          receipt: getReceipt,
          code,
        })
      : undefined;
    markets.push({
      accounting,
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
    options.onProgress?.(
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
  // Keep complete responses within the Next Data Cache and function limits.
  // Never truncate swaps or publish PnL calculated from a partial scan.
  if (Buffer.byteLength(JSON.stringify(snapshot)) > 1800000)
    throw Error("Snapshot exceeds response budget; use persistent ingestion");
  evidence.blocks = [...blockCache.values()];
  return { snapshot, evidence };
}
