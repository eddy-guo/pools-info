import { getInstantDeployment } from "./deployments";
import {
  decodeFunctionResult,
  encodeFunctionData,
  erc20Abi,
  toEventSelector,
  type Hex,
} from "viem";
import { mergeCatalog, type ChainCatalog, type CatalogPool } from "@pools/core";
import { contracts, decodeLaunch, launchEvent } from "./events";
import { Rpc, hex } from "./rpc";
import type { Receipt } from "./audit";
export interface CatalogRange {
  fromBlock: number;
  toBlock: number;
}
// Metadata discovery only: no swap, transfer, balance or trader backfill.
export async function collectCatalog(
  previous?: ChainCatalog,
  rpc = new Rpc(undefined, { timeoutMs: 120000, maxRequests: 1000 }),
  range?: CatalogRange,
) {
  if (
    range &&
    (previous ||
      !Number.isSafeInteger(range.fromBlock) ||
      !Number.isSafeInteger(range.toBlock) ||
      range.fromBlock < 0 ||
      range.toBlock < range.fromBlock ||
      range.toBlock - range.fromBlock >= 2000)
  )
    throw Error(
      "Explicit catalog range must be at most 2000 blocks with no previous catalog",
    );
  if (Number(await rpc.call<Hex>("eth_chainId", [])) !== 4663)
    throw Error("Wrong chain");
  const head = Number(await rpc.call<Hex>("eth_blockNumber", []));
  if (!Number.isSafeInteger(head) || head < (range ? 128 : 100128))
    throw Error("Invalid chain head");
  const toBlock = range?.toBlock ?? head - 128;
  if (toBlock > head - 128)
    throw Error("Catalog range exceeds confirmed cutoff");
  if (
    previous &&
    (previous.chainId !== 4663 ||
      previous.schemaVersion !== 1 ||
      previous.toBlock > toBlock)
  )
    throw Error("Invalid catalog checkpoint");
  type Header = { number: Hex; hash: Hex; timestamp: Hex };
  if (previous) {
    const block = await rpc.call<Header>("eth_getBlockByNumber", [
      hex(previous.toBlock),
      false,
    ]);
    if (!block || block.hash !== previous.blockHash)
      throw Error(
        "Catalog checkpoint changed; rebuild before extending coverage",
      );
  }
  const fromBlock =
    range?.fromBlock ??
    Math.max(toBlock - 99999, previous ? previous.toBlock - 128 : 0);
  const logs = await rpc.logs(
    contracts.strategies,
    [toEventSelector(launchEvent)],
    fromBlock,
    toBlock,
  );
  if (logs.length > 250)
    throw Error(
      "Catalog batch exceeds 250 launches; split the scan before publishing",
    );
  if (
    logs.some(
      (l) =>
        !Number.isSafeInteger(Number(l.blockNumber)) ||
        Number(l.blockNumber) < fromBlock ||
        Number(l.blockNumber) > toBlock,
    )
  )
    throw Error("Out-of-range catalog log");
  const decoded = logs.map((l) => {
    const launch = decodeLaunch(l);
    if (
      Number(l.blockNumber) < getInstantDeployment(l.address)!.deployedAtBlock
    )
      throw Error("Launch precedes verified deployment");
    return launch;
  });
  const heights = [
    ...new Set([toBlock, ...logs.map((l) => Number(l.blockNumber))]),
  ];
  const headers = await rpc.batch<Header>(
    "eth_getBlockByNumber",
    heights.map((n) => [hex(n), false]),
  );
  const blocks = new Map(
    headers.map((b, i) => {
      if (!b || Number(b.number) !== heights[i]) throw Error("Missing header");
      return [heights[i], b];
    }),
  );
  const hashes = [...new Set(logs.map((l) => l.transactionHash))];
  const receipts = await rpc.batch<Receipt>(
    "eth_getTransactionReceipt",
    hashes.map((h) => [h]),
  );
  if (receipts.length !== hashes.length) throw Error("Missing catalog receipt");
  const receiptMap = new Map(
    receipts.map((r, i) => {
      if (!r || r.transactionHash !== hashes[i]) throw Error("Missing receipt");
      return [r.transactionHash, r];
    }),
  );
  for (const l of logs) {
    const r = receiptMap.get(l.transactionHash)!;
    if (
      r.status !== "0x1" ||
      r.blockHash !== l.blockHash ||
      blocks.get(Number(l.blockNumber))!.hash !== l.blockHash ||
      !r.logs.some(
        (e) =>
          e.address.toLowerCase() === getInstantDeployment(l.address)!.launcher,
      ) ||
      !r.logs.some(
        (e) =>
          e.address.toLowerCase() === l.address.toLowerCase() &&
          e.logIndex === l.logIndex &&
          e.data === l.data &&
          e.topics.join() === l.topics.join(),
      )
    )
      throw Error("Unverified catalog launch");
  }
  const fields = ["name", "symbol"] as const;
  const metadata = await rpc.batch<Hex>(
    "eth_call",
    decoded.flatMap((d) =>
      fields.map((functionName) => [
        {
          to: d.token,
          data: encodeFunctionData({ abi: erc20Abi, functionName }),
        },
        hex(toBlock),
      ]),
    ),
  );
  const pools: CatalogPool[] = decoded.map((d, i) => ({
    id: d.poolId,
    token: d.token,
    name: String(
      decodeFunctionResult({
        abi: erc20Abi,
        functionName: "name",
        data: metadata[i * 2],
      }),
    ).slice(0, 160),
    symbol: String(
      decodeFunctionResult({
        abi: erc20Abi,
        functionName: "symbol",
        data: metadata[i * 2 + 1],
      }),
    ).slice(0, 40),
    launchTx: logs[i].transactionHash,
    launchSender: receiptMap.get(logs[i].transactionHash)!.from,
    launchBlock: Number(logs[i].blockNumber),
    launchedAt: Number(blocks.get(Number(logs[i].blockNumber))!.timestamp),
  }));
  const cutoff = blocks.get(toBlock)!;
  if (
    (await rpc.call<Header>("eth_getBlockByNumber", [hex(toBlock), false]))
      .hash !== cutoff.hash
  )
    throw Error("Cutoff changed during collection");
  const catalog = mergeCatalog(previous, {
    schemaVersion: 1,
    chainId: 4663,
    generatedAt: new Date().toISOString(),
    toBlock,
    fromBlock,
    blockHash: cutoff.hash,
    pools,
  });
  if (catalog.pools.length > 2000)
    throw Error(
      "Catalog needs partitioning beyond 2,000 pools; preserve existing file",
    );
  return {
    catalog,
    evidence: { logs, receipts, headers },
    requests: rpc.requests,
  };
}
