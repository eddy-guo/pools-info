import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  broadEventPolicy,
  collectPoolEventGroup,
  contracts,
  type BroadPoolEventGroup,
  type BroadPoolIdentity,
  type Rpc,
} from "@pools/chain";
import { discoveryV2Identity } from "./discovery";
import { getStream, type Client, type Stream } from "./index";

export const broadStreamIdentity = Object.freeze({
  key: "swaps:broad:v1",
  start: discoveryV2Identity.start,
  registryRevision: discoveryV2Identity.registryRevision,
  registrySourceRevision: discoveryV2Identity.registrySourceRevision,
});
export interface BroadPoolCommit {
  mode: "broad";
  expected: Stream;
  group: BroadPoolEventGroup;
}
export type { BroadPoolEventGroup, BroadIndexedSwap } from "@pools/chain";

/** Called under the existing writer lock. Creates no discovery or deep streams. */
export async function ensureBroadStream(db: Client): Promise<Stream> {
  const id = broadStreamIdentity;
  await db.query(
    `INSERT INTO indexer_streams(chain_id,stream_key,kind,start_block,registry_revision,registry_source_revision)
      VALUES(4663,$1,'broad',$2,$3,$4) ON CONFLICT DO NOTHING`,
    [id.key, id.start, id.registryRevision, id.registrySourceRevision],
  );
  await checkedBroadStream(db);
  return getStream(db, id.key);
}
async function checkedBroadStream(db: Client) {
  const id = broadStreamIdentity;
  const row = (
    await db.query(
      "SELECT * FROM indexer_streams WHERE chain_id=4663 AND stream_key=$1 FOR UPDATE",
      [id.key],
    )
  ).rows[0];
  if (
    !row ||
    row.kind !== "broad" ||
    row.pool_id !== null ||
    Number(row.start_block) !== id.start ||
    row.registry_revision !== id.registryRevision ||
    row.registry_source_revision !== id.registrySourceRevision
  )
    throw Error("Broad stream identity changed");
  return row;
}

/** Validate against retained bytes using the collector's decoder and canonical
 * evidence checks. The adapter has no network methods or provider fallback. */
async function checkedGroup(group: BroadPoolEventGroup) {
  if (
    group.mode !== "broad" ||
    group.schemaVersion !== 1 ||
    group.chainId !== 4663 ||
    group.manager !== contracts.manager ||
    group.pools.length > broadEventPolicy.maxLogs ||
    group.swaps.length > broadEventPolicy.maxLogs ||
    group.evidence.swapLogs.length > broadEventPolicy.maxLogs
  )
    throw Error("Invalid broad commit group");
  const headers = new Map(
    group.evidence.headers.map((h) => [Number(h.number), h]),
  );
  const receipts = new Map(
    group.evidence.receipts.map((r) => [r.transactionHash.toLowerCase(), r]),
  );
  const evidenceRpc = {
    requests: 0,
    call: async (method: string) => {
      if (method === "eth_chainId") return "0x1237";
      if (method === "eth_blockNumber")
        return `0x${(group.registry.throughBlock + 128).toString(16)}`;
      throw Error("Unexpected broad evidence call");
    },
    logs: async () => [...group.evidence.swapLogs],
    batch: async (method: string, params: unknown[][]) => {
      if (method === "eth_getBlockByNumber")
        return params.map((p) => headers.get(Number(p[0])));
      if (method === "eth_getTransactionReceipt")
        return params.map((p) => receipts.get(String(p[0]).toLowerCase()));
      throw Error("Unexpected broad evidence batch");
    },
  } as unknown as Rpc;
  const verified = await collectPoolEventGroup(
    {
      mode: "broad",
      fromBlock: group.fromBlock,
      toBlock: group.toBlock,
      registry: group.registry,
      resolvePools: async () => group.pools,
    },
    evidenceRpc,
  );
  if (!isDeepStrictEqual(verified, { ...group, requests: 0 }))
    throw Error("Broad rows disagree with retained evidence");
}

/** The caller owns BEGIN/COMMIT. Lock discovery before broad so rollback and
 * commit serialize over the exact saved covering checkpoint, not today's tip. */
export async function commitBroadGroupInTransaction(
  db: Client,
  expected: Stream,
  group: BroadPoolEventGroup,
  serialized: string,
): Promise<boolean> {
  const id = discoveryV2Identity;
  const discovery = (
    await db.query(
      "SELECT * FROM indexer_streams WHERE chain_id=4663 AND stream_key=$1 FOR UPDATE",
      [id.key],
    )
  ).rows[0];
  const pin = group.registry;
  if (
    !discovery ||
    discovery.kind !== "discovery" ||
    discovery.pool_id !== null ||
    Number(discovery.start_block) !== id.start ||
    discovery.registry_revision !== id.registryRevision ||
    discovery.registry_source_revision !== id.registrySourceRevision ||
    pin.stream !== id.key ||
    pin.revision !== id.registryRevision ||
    pin.sourceRevision !== id.registrySourceRevision ||
    discovery.cursor_block === null ||
    Number(discovery.cursor_block) < pin.throughBlock ||
    group.toBlock > pin.throughBlock
  )
    throw Error("Broad discovery coverage or identity changed");
  const checkpoint = (
    await db.query(
      `SELECT block_hash,content_hash,evidence->>'registryRevision' AS revision,evidence->>'registrySourceRevision' AS source_revision
       FROM indexer_batches WHERE chain_id=4663 AND stream_key=$1 AND to_block=$2 FOR SHARE`,
      [id.key, pin.throughBlock],
    )
  ).rows[0];
  if (
    !checkpoint ||
    checkpoint.block_hash !== pin.blockHash ||
    checkpoint.revision !== id.registryRevision ||
    checkpoint.source_revision !== id.registrySourceRevision
  )
    throw Error("Broad discovery checkpoint changed");
  const current = await checkedBroadStream(db);
  if (
    expected.key !== broadStreamIdentity.key ||
    expected.kind !== "broad" ||
    expected.poolId !== null ||
    expected.start !== broadStreamIdentity.start
  )
    throw Error("Invalid broad expected stream");
  await checkedGroup(group);

  // Resolve EVERY observed ID again, including claimed unregistered swaps.
  // A launch from v1/candidate alone does not enter the pinned v2 registry.
  const observed = [
    ...new Set(group.evidence.swapLogs.map((l) => l.topics[1].toLowerCase())),
  ];
  const members = (
    await db.query(
      `SELECT p.pool_id,p.token,p.launch_block::text,p.launch_tx,p.launch_sender,p.launched_at::text,
        s.batch_end::text AS source_batch,b.from_block::text AS source_from,b.block_hash AS source_hash,b.content_hash AS source_content_hash,
        b.evidence->>'registryRevision' AS source_revision,b.evidence->>'registrySourceRevision' AS source_registry_revision
       FROM indexed_pools p
       JOIN pool_launch_sources s ON s.chain_id=p.chain_id AND s.pool_id=p.pool_id
       JOIN indexer_batches b ON b.chain_id=s.chain_id AND b.stream_key=s.stream_key AND b.to_block=s.batch_end
       WHERE p.chain_id=4663 AND p.pool_id=ANY($1::text[]) AND s.stream_key=$2 AND s.batch_end<=$3
       ORDER BY p.pool_id,s.batch_end FOR SHARE OF p,s,b`,
      [observed, id.key, pin.throughBlock],
    )
  ).rows;
  if (new Set(members.map((p) => p.pool_id)).size !== members.length)
    throw Error("Ambiguous broad launch provenance");
  if (
    members.some(
      (p) =>
        p.source_revision !== id.registryRevision ||
        p.source_registry_revision !== id.registrySourceRevision ||
        Number(p.launch_block) < Number(p.source_from) ||
        Number(p.launch_block) > Number(p.source_batch),
    )
  )
    throw Error("Broad launch source identity changed");
  const pools: BroadPoolIdentity[] = members.map((p) => ({
    poolId: p.pool_id,
    token: p.token,
    launchBlock: Number(p.launch_block),
  }));
  if (!isDeepStrictEqual(pools, group.pools))
    throw Error("Broad registry members or source identity changed");

  const contentHash = createHash("sha256").update(serialized).digest("hex");
  const previous = (
    await db.query(
      `SELECT b.from_block,b.block_hash,b.content_hash,x.serialized_group,x.discovery_content_hash
       FROM indexer_batches b JOIN broad_batches x ON x.chain_id=b.chain_id AND x.stream_key=b.stream_key AND x.batch_end=b.to_block
       WHERE b.chain_id=4663 AND b.stream_key=$1 AND b.to_block=$2`,
      [expected.key, group.toBlock],
    )
  ).rows[0];
  if (previous) {
    if (
      Number(previous.from_block) !== group.fromBlock ||
      previous.block_hash !== group.blockHash ||
      previous.content_hash !== contentHash ||
      previous.serialized_group !== serialized
    )
      throw Error("Conflicting broad replay");
    if (previous.discovery_content_hash !== checkpoint.content_hash)
      throw Error("Broad replay discovery source identity changed");
    const savedMembers = (
      await db.query(
        "SELECT identity FROM broad_registry_members WHERE chain_id=4663 AND stream_key=$1 AND batch_end=$2 ORDER BY pool_id",
        [expected.key, group.toBlock],
      )
    ).rows.map((p) => p.identity);
    if (!isDeepStrictEqual(savedMembers, members))
      throw Error("Broad replay source identity changed");
    return false;
  }
  if (
    (current.cursor_block === null ? null : Number(current.cursor_block)) !==
      expected.cursor ||
    current.cursor_hash !== expected.hash ||
    group.fromBlock !==
      (expected.cursor === null ? expected.start : expected.cursor + 1) ||
    (expected.hash !== null && group.fromBlockParentHash !== expected.hash)
  )
    throw Error("Stale broad checkpoint or noncontiguous batch");
  await db.query(
    `INSERT INTO indexer_batches(chain_id,stream_key,from_block,to_block,block_hash,content_hash,evidence)
     VALUES(4663,$1,$2,$3,$4,$5,'{"broadSerializerVersion":1}')`,
    [
      expected.key,
      group.fromBlock,
      group.toBlock,
      group.blockHash,
      contentHash,
    ],
  );
  await db.query(
    `INSERT INTO broad_batches(chain_id,stream_key,batch_end,from_block,parent_hash,timestamp,discovery_stream,discovery_batch,discovery_hash,serializer_version,serialized_group,observed_swaps,unregistered_swaps,unsupported_swaps,discovery_content_hash)
     VALUES(4663,$1,$2,$3,$4,$5,$6,$7,$8,1,$9,$10,$11,$12,$13)`,
    [
      expected.key,
      group.toBlock,
      group.fromBlock,
      group.fromBlockParentHash,
      group.toTimestamp,
      pin.stream,
      pin.throughBlock,
      pin.blockHash,
      serialized,
      group.observedSwaps,
      group.unregisteredSwaps,
      group.unsupportedSwaps,
      checkpoint.content_hash,
    ],
  );
  if (members.length)
    await db.query(
      `INSERT INTO broad_registry_members(chain_id,stream_key,batch_end,pool_id,identity)
       SELECT 4663,$1,$2,x->>'pool_id',x FROM jsonb_array_elements($3::jsonb) x`,
      [expected.key, group.toBlock, JSON.stringify(members)],
    );
  if (group.swaps.length)
    await db.query(
      `INSERT INTO broad_swaps(chain_id,stream_key,batch_end,pool_id,token,tx_hash,log_index,block_number,block_hash,timestamp,transaction_sender,manager_sender,amount0,amount1,sqrt_price_x96,liquidity,tick,fee,side,eth_wei,token_raw,supported,flags)
       SELECT 4663,$1,$2,x."poolId",x.token,x."txHash",x."logIndex",x.block,x."blockHash",x.timestamp,x."transactionSender",x."managerSender",x.amount0,x.amount1,x."sqrtPriceX96",x.liquidity,x.tick,x.fee,x.side,x."ethWei",x."tokenRaw",x.supported,x.flags
       FROM jsonb_to_recordset($3::jsonb) AS x("poolId" text,token text,"txHash" text,"logIndex" integer,block bigint,"blockHash" text,timestamp bigint,"transactionSender" text,"managerSender" text,amount0 numeric,amount1 numeric,"sqrtPriceX96" numeric,liquidity numeric,tick integer,fee integer,side text,"ethWei" numeric,"tokenRaw" numeric,supported boolean,flags text[])`,
      [expected.key, group.toBlock, JSON.stringify(group.swaps)],
    );
  await db.query(
    "UPDATE indexer_streams SET cursor_block=$2,cursor_hash=$3,updated_at=clock_timestamp() WHERE chain_id=4663 AND stream_key=$1",
    [expected.key, group.toBlock, group.blockHash],
  );
  return true;
}

/** Snapshot before any await so callers cannot change the group during commit.
 * RPC request counts are telemetry, not retained semantic range content. */
export function snapshotBroadCommit(entry: BroadPoolCommit) {
  const serialized = JSON.stringify({ ...entry.group, requests: 0 });
  if (Buffer.byteLength(serialized) > broadEventPolicy.maxBytes)
    throw Error("Broad event group exceeds capacity; split the range");
  return {
    expected: { ...entry.expected },
    group: JSON.parse(serialized) as BroadPoolEventGroup,
    serialized,
  };
}
