import { readdir, readFile } from "node:fs/promises";
import type pg from "pg";

/** Apply every packages/db migration to the session's current schema. The
 * integration suites run as parallel processes against one database, and
 * `CREATE EXTENSION IF NOT EXISTS` is not atomic across sessions, so the same
 * advisory lock the production runner takes serializes each setup. */
export async function applyTestMigrations(db: pg.Client) {
  const directory = new URL(
    "../../../packages/db/migrations/",
    import.meta.url,
  );
  await db.query("SELECT pg_advisory_lock(4663, 19001)");
  try {
    for (const name of (await readdir(directory))
      .filter((n) => n.endsWith(".sql"))
      .sort())
      await db.query(await readFile(new URL(name, directory), "utf8"));
  } finally {
    await db.query("SELECT pg_advisory_unlock(4663, 19001)");
  }
}
