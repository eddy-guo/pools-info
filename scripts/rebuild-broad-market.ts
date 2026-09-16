import {
  acquireWriter,
  createClient,
  rebuildBroadMarket,
} from "../packages/db/src/index";
// Explicit operation: no implicit env-file loading, migrations, RPC, or loops.
// Invoke again until remaining=0; every invocation has a bounded batch count.
const db = createClient();
await db.connect();
try {
  if (!(await acquireWriter(db))) throw Error("Canonical writer is busy");
  console.log(
    JSON.stringify(await rebuildBroadMarket(db, Number(process.argv[2] ?? 10))),
  );
} finally {
  await db.end();
}
