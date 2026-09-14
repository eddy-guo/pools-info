import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { collectCatalog } from "@pools/chain";
type ChainCatalog = Awaited<ReturnType<typeof collectCatalog>>["catalog"];
async function main() {
  let previous: ChainCatalog | undefined;
  try {
    previous = JSON.parse(await readFile("data/catalog/chain.json", "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const { catalog, evidence, requests } = await collectCatalog(previous);
  await mkdir("data/catalog", { recursive: true });
  await mkdir(".data/catalog", { recursive: true });
  await writeFile(
    `.data/catalog/${catalog.toBlock}.json`,
    JSON.stringify(evidence),
  );
  await writeFile(
    "data/catalog/chain.json.tmp",
    JSON.stringify(catalog, null, 2) + "\n",
  );
  await rename("data/catalog/chain.json.tmp", "data/catalog/chain.json");
  console.log(
    JSON.stringify({
      pools: catalog.pools.length,
      ranges: catalog.ranges,
      toBlock: catalog.toBlock,
      requests,
    }),
  );
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Catalog failed");
  process.exitCode = 1;
});
