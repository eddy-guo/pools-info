import { Rpc } from "@pools/chain";
import {
  checkpoints,
  rewind,
  getStream,
  type Client,
  type Stream,
} from "@pools/db";
const hex = (n: number) => `0x${n.toString(16)}`;
type Header = { number: string; hash: string; parentHash: string };
export async function canonicalHeader(client: Rpc, n: number) {
  const b = await client.call<Header>("eth_getBlockByNumber", [hex(n), false]);
  if (!b || Number(b.number) !== n || !/^0x[0-9a-f]{64}$/i.test(b.hash))
    throw Error("Missing canonical header");
  return b;
}
export async function reconcileStream(
  db: Client,
  s: Stream,
  client: Rpc,
  read = (n: number) => canonicalHeader(client, n),
): Promise<Stream> {
  if (s.cursor === null) return s;
  if ((await read(s.cursor)).hash === s.hash) return s;
  let ancestor: number | null = null;
  for (const batch of await checkpoints(db, s.key)) {
    if ((await read(batch.to)).hash === batch.hash) {
      ancestor = batch.to;
      break;
    }
  }
  await rewind(db, s, ancestor);
  console.log(
    JSON.stringify({
      event: "rewind",
      stream: s.key,
      from: s.cursor,
      to: ancestor,
    }),
  );
  return getStream(db, s.key);
}
