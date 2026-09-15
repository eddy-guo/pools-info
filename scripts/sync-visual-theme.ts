import { readFile, writeFile } from "node:fs/promises";
import { renderVisualThemeCss } from "../packages/core/src/visual-theme";

async function main() {
  const target = new URL(
    "../apps/web/src/app/visual-theme.css",
    import.meta.url,
  );
  const expected = renderVisualThemeCss();
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) {
    throw new Error("Usage: tsx scripts/sync-visual-theme.ts [--check]");
  }
  if (args[0] === "--check") {
    const actual = await readFile(target, "utf8").catch(() => null);
    if (actual !== expected) {
      console.error(
        "Visual theme CSS is stale. Run pnpm exec tsx scripts/sync-visual-theme.ts.",
      );
      process.exitCode = 1;
    }
  } else {
    await writeFile(target, expected);
  }
}

void main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : "Visual theme sync failed.",
  );
  process.exitCode = 1;
});
