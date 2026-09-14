export interface CatalogPool {
  id: string;
  token: string;
  name: string;
  symbol: string;
  launchTx: string;
  launchSender: string;
  launchBlock: number;
  launchedAt: number;
}
export interface ChainCatalog {
  schemaVersion: 1;
  chainId: 4663;
  generatedAt: string;
  toBlock: number;
  blockHash: string;
  ranges: { fromBlock: number; toBlock: number }[];
  pools: CatalogPool[];
}
export function mergeCatalog(
  previous: ChainCatalog | undefined,
  next: Omit<ChainCatalog, "ranges"> & { fromBlock: number },
): ChainCatalog {
  if (previous && next.toBlock < previous.toBlock)
    throw Error("Catalog cannot move backwards");
  const entries = new Map(
    (previous?.pools ?? [])
      .filter((p) => p.launchBlock < next.fromBlock)
      .map((p) => [p.id, p]),
  );
  for (const p of next.pools) entries.set(p.id, p);
  const ranges = [
    ...(previous?.ranges ?? []),
    { fromBlock: next.fromBlock, toBlock: next.toBlock },
  ].sort((a, b) => a.fromBlock - b.fromBlock);
  const merged: ChainCatalog["ranges"] = [];
  for (const r of ranges) {
    const last = merged.at(-1);
    if (last && r.fromBlock <= last.toBlock + 1)
      last.toBlock = Math.max(last.toBlock, r.toBlock);
    else merged.push({ ...r });
  }
  return {
    schemaVersion: 1,
    chainId: 4663,
    generatedAt: next.generatedAt,
    toBlock: next.toBlock,
    blockHash: next.blockHash,
    ranges: merged,
    pools: [...entries.values()].sort(
      (a, b) => b.launchBlock - a.launchBlock || a.id.localeCompare(b.id),
    ),
  };
}
