import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test, expect } from "@playwright/test";

const fixtureToken = "0x433025FE9550ed919d8b28b53a3F5419BE678D0D"; // MEEP in data/catalog/chain.json
const remoteToken = "0x199157Bf8Fc3b85aF2A40E7BBe718893a9B56Fd0"; // MONKI in data/snapshots/chain.json

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw Error("No test port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

test("production Cmd-K excludes a fixture-only token while showing an indexed result", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const { PRODUCT_FIXTURES: _fixtures, ...env } = process.env;
  const server = spawn(
    process.execPath,
    [
      resolve("apps/web/node_modules/next/dist/bin/next"),
      "start",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    {
      cwd: resolve("apps/web"),
      env: { ...env, CHAIN_REFRESH_DISABLED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let serverOutput = "";
  server.stdout.on("data", (chunk: Buffer) => (serverOutput += chunk));
  server.stderr.on("data", (chunk: Buffer) => (serverOutput += chunk));
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100 && !ready; attempt++) {
      if (server.exitCode !== null) throw Error(serverOutput);
      try {
        const response = await fetch(origin, { signal: AbortSignal.timeout(500) });
        ready = response.ok;
      } catch {
        await delay(100);
      }
    }
    if (!ready) throw Error(`Production server did not start: ${serverOutput}`);

    let remoteRead = false;
    await page.route("**/api/product/search/?**", async (route) => {
      if (new URL(route.request().url()).searchParams.get("q") !== "meep")
        return route.fulfill({
          json: { entries: [], total: 0, kind: "text", coverage: { scope: "indexed", pools: 1, fromBlock: 1, toBlock: 2 } },
        });
      remoteRead = true;
      await route.fulfill({
        json: {
          entries: [{
            id: `token:${remoteToken}`,
            group: "Tokens",
            address: remoteToken,
            title: "MonkiiLabs",
            context: "Indexed pool",
            terms: ["MONKI"],
            href: `/pool/${remoteToken}/`,
          }],
          total: 1,
          kind: "text",
          coverage: { scope: "indexed", pools: 1, fromBlock: 1, toBlock: 2 },
        },
      });
    });

    await page.goto(origin);
    await page.getByRole("button", {
      name: "Search tokens, wallets, creators, transactions",
    }).click();
    const dialog = page.getByRole("dialog", { name: "Search Pools Info" });
    await dialog.getByRole("textbox").fill("meep");
    await expect(dialog.getByRole("link", { name: /MonkiiLabs/ })).toBeVisible();
    expect(remoteRead).toBe(true);
    await expect(dialog.locator(`a[href*="${fixtureToken}"]`)).toHaveCount(0);
  } finally {
    if (server.exitCode === null) {
      server.kill("SIGTERM");
      await new Promise<void>((resolve) => server.once("exit", () => resolve()));
    }
  }
});
