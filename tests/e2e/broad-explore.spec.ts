import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
const marketWord = (n: number) => "0x" + n.toString(16).padStart(64, "0");
const marketAmount = "900719925474099300003";

test.describe("persisted broad market explore", () => {
  test.skip(!process.env.TEST_DATABASE_URL, "Requires isolated local Postgres");
  let server: ChildProcess;
  test.beforeAll(async () => {
    server = spawn(
      process.execPath,
      ["--import", "tsx", "tests/support/market-server.ts"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    await new Promise<void>((resolve, reject) => {
      let output = "";
      server.stdout!.on("data", (chunk) => {
        output += chunk.toString();
        if (output.includes("MARKET_DATABASE_READY")) resolve();
      });
      server.stderr!.on("data", (chunk) => {
        output += chunk.toString();
      });
      server.once("exit", (code) =>
        reject(new Error(`Market fixture exited ${code}: ${output}`)),
      );
    });
  });
  test.afterAll(async () => {
    if (server && server.exitCode === null)
      await new Promise<void>((resolve) => {
        server.once("exit", () => resolve());
        server.kill("SIGTERM");
      });
  });
  test("real explore API and page retain all launches, exact market values and URL sort state", async ({
    page,
    request,
  }, info) => {
    // Block unrelated live transport. Product requests use the actual local API
    // and canonical Postgres rows through the unchanged production proxy.
    await page.route("**/api/markets/**", (route) => route.abort());
    await page.goto("/?sort=trades&window=All");
    const response = await request.get(
      "/api/product/explore?sort=trades&window=All&limit=1",
    );
    const data = await response.json();
    expect(data.delivery.source).toBe("indexer");
    // Trade-count order lists the 30 covered launches; launch 31 is past the
    // broad cutoff and only appears in launch order.
    expect(data.total).toBe(30);
    expect(data.items[0].stats.trades).toBe(21001);
    expect(data.items[0].stats.volumeWei).toBe(
      (BigInt(marketAmount) * 21001n).toString(),
    );
    expect(data.items[0].stats.priceWei).toBe("4000000000000000000");
    expect(data.items[0].processed).toBe(false);
    await expect(
      page.getByRole("combobox", { name: "Sort all pools" }),
    ).toHaveValue("trades");
    const row = page
      .locator(".desktop-pools tbody tr, .mobile-pool")
      .filter({ visible: true })
      .filter({ has: page.getByRole("link", { name: /Canonical market/ }) });
    await expect(row).toBeVisible();
    await expect(row).toContainText("21001");
    await expect(row).toContainText("Broad swaps");
    await expect(
      row.locator(`[title="${BigInt(marketAmount) * 21001n} wei"]`),
    ).toBeVisible();
    await page
      .getByRole("combobox", { name: "Sort all pools" })
      .selectOption("volume");
    await expect(page).toHaveURL(/sort=volume/);
    await expect(
      page.getByRole("combobox", { name: "Sort all pools" }),
    ).toHaveValue("volume");
    await page.getByRole("textbox", { name: "Filter pools" }).fill("Launch 31");
    await expect(
      page.getByRole("heading", { name: "No pools match these filters" }),
    ).toBeVisible();
    await page
      .getByRole("combobox", { name: "Sort all pools" })
      .selectOption("launch");
    await expect(page).toHaveURL(/sort=launch/);
    await expect(
      page
        .locator(".desktop-pools .token-cell, .mobile-pools .token-cell")
        .filter({ visible: true }),
    ).toHaveCount(1);
    await expect(
      page
        .locator(".desktop-pools .token-cell, .mobile-pools .token-cell")
        .filter({ visible: true })
        .filter({ hasText: "Launch 31" }),
    ).toBeVisible();
    const unavailable = await (
      await request.get("/api/product/explore?q=Launch%2031")
    ).json();
    expect(unavailable.items[0].id).toBe(marketWord(31));
    expect(unavailable.items[0].stats.volumeWei).toBeNull();
    await page.getByRole("textbox", { name: "Filter pools" }).fill("Canonical");
    await expect(row).toBeVisible();
    await page.screenshot({
      path: info.outputPath("persisted-broad-explore.png"),
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await expect(
      page.getByText(/Deep holders and verified PnL use separate evidence/),
    ).toBeVisible();
  });
});
