import { createReader } from "../../apps/api/src/reader";
import { createApi } from "../../apps/api/src/server";
import { rebuildBroadMarket } from "../../packages/db/src/index";
import { marketDatabase, marketUnits } from "./broad-market-db";
async function main() {
  const fixture = await marketDatabase();
  const reader = createReader(process.env.TEST_DATABASE_URL, fixture.schema),
    api = createApi(reader, { cacheMs: 0 });
  const close = async () => {
    await new Promise<void>((resolve) => api.close(() => resolve()));
    await reader.close();
    await fixture.close();
  };
  try {
    await rebuildBroadMarket(fixture.db, 100);
    await marketUnits(fixture.db);
    await new Promise<void>((resolve, reject) => {
      api.once("error", reject);
      api.listen(43119, "127.0.0.1", resolve);
    });
    process.once("SIGTERM", () => {
      void close().then(() => process.exit(0));
    });
    console.log("MARKET_DATABASE_READY");
  } catch (error) {
    await close();
    throw error;
  }
}
void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
