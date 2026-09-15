import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { renderVisualThemeCss } from "./visual-theme";

const source = (path: string) =>
  readFile(new URL(`../../../${path}`, import.meta.url), "utf8");

test("browser theme artifact matches the shared palette used by chart and card renderers", async () => {
  const [generated, globals] = await Promise.all([
    source("apps/web/src/app/visual-theme.css"),
    source("apps/web/src/app/globals.css"),
  ]);
  assert.equal(
    generated,
    renderVisualThemeCss(),
    "Run pnpm exec tsx scripts/sync-visual-theme.ts after editing the palette",
  );
  assert.match(globals, /@import\s+["']\.\/visual-theme\.css["'];/);
  assert.doesNotMatch(
    globals,
    /--color-[\w-]+\s*:/,
    "Keep palette declarations in the generated theme rather than overriding them",
  );
});

test("chart, card, and default avatar colors cannot drift into private hex palettes", async () => {
  for (const path of [
    "apps/web/src/components/candles.tsx",
    "apps/web/src/app/cards/[filename]/route.tsx",
    "apps/web/src/components/ui.tsx",
  ]) {
    const code = await source(path);
    assert.match(
      code,
      /visualTheme/,
      `${path} must consume the shared palette`,
    );
    assert.doesNotMatch(
      code,
      /#[\da-f]{3,8}\b/i,
      `${path} must use a shared token instead of a private color literal`,
    );
  }
});
