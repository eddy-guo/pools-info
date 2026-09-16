import { test, expect } from "@playwright/test";

const address = "0x1111111111111111111111111111111111111111";
const coverage = { scope: "indexed", pools: 1, fromBlock: 1, toBlock: 100 };

test("ENS wallet remains one result when the saved index adds a different query string", async ({
  page,
}) => {
  let release: () => void = () => {};
  let requested = false;
  await page.route("**/api/markets/", (route) =>
    route.fulfill({ status: 503, json: { error: "disabled" } }),
  );
  await page.route("**/api/ens/?**", (route) =>
    route.fulfill({ json: { name: "example.eth", address } }),
  );
  await page.route("**/api/product/search/?**", async (route) => {
    const query = new URL(route.request().url()).searchParams.get("q");
    if (query !== `wallet:${address}`)
      return route.fulfill({
        json: { entries: [], total: 0, kind: "text", coverage },
      });
    await new Promise<void>((resolve) => {
      release = resolve;
      requested = true;
    });
    await route.fulfill({
      json: {
        entries: [
          {
            id: `wallet:${address}`,
            group: "Wallets",
            address,
            title: address,
            context: "Saved wallet across processed pools",
            terms: [address],
            href: `/wallet/${address}/?window=All`,
          },
        ],
        total: 1,
        kind: "address",
        coverage,
        delivery: { source: "indexer", notice: "Saved wallet loaded" },
      },
    });
  });
  await page.goto("/");
  await page
    .getByRole("button", {
      name: "Search tokens, wallets, creators, transactions",
    })
    .click();
  const dialog = page.getByRole("dialog", { name: "Search Pools Info" });
  await dialog.getByRole("textbox").fill("example.eth");
  await expect.poll(() => requested).toBe(true);
  await expect(dialog.getByRole("link", { name: /example.eth/ })).toHaveCount(
    1,
  );
  release();
  await expect(dialog.getByText("Saved wallet loaded")).toBeVisible();
  await expect(dialog.getByRole("link", { name: /example.eth/ })).toHaveCount(
    1,
  );
  await expect(dialog.getByRole("link", { name: /example.eth/ })).toContainText(
    "Saved wallet across processed pools",
  );
  await expect(
    dialog.getByRole("link", { name: /example.eth/ }),
  ).toHaveAttribute("href", `/wallet/${address}/`);
});

test("address search merges equivalent wallets but retains a distinct creator result", async ({
  page,
}) => {
  await page.route("**/api/markets/", (route) =>
    route.fulfill({ status: 503, json: { error: "disabled" } }),
  );
  await page.route("**/api/product/search/?**", async (route) => {
    const q = new URL(route.request().url()).searchParams.get("q") ?? "";
    const entries = [
      {
        id: "saved-wallet",
        group: "Wallets",
        address,
        title: "Saved wallet",
        context: "Saved indexed wallet",
        terms: [address],
        href: `/wallet/${address}/?window=All`,
      },
      {
        id: "saved-creator",
        group: "Creators",
        address,
        title: "Saved creator",
        context: "Saved indexed creator",
        terms: [address],
        href: `/creators/${address}/`,
      },
    ].filter(
      (entry) => !q.startsWith("creator:") || entry.group === "Creators",
    );
    await route.fulfill({
      json: {
        entries,
        total: entries.length,
        kind: "address",
        coverage,
        delivery: { source: "indexer", notice: "Identity matches loaded" },
      },
    });
  });
  await page.goto("/");
  await page
    .getByRole("button", {
      name: "Search tokens, wallets, creators, transactions",
    })
    .click();
  const dialog = page.getByRole("dialog", { name: "Search Pools Info" });
  const input = dialog.getByRole("textbox");
  await input.fill(address);
  await expect(dialog.getByText("Identity matches loaded")).toBeVisible();
  await expect(dialog.locator(`a[href^="/wallet/${address}/"]`)).toHaveCount(1);
  await expect(dialog.locator(`a[href^="/creators/${address}/"]`)).toHaveCount(
    1,
  );
  await input.fill(`creator:${address}`);
  await expect(
    dialog.getByRole("link", { name: /Saved creator/ }),
  ).toBeVisible();
  await expect(dialog.locator(`a[href^="/creators/${address}/"]`)).toHaveCount(
    1,
  );
  await expect(dialog.locator(`a[href^="/wallet/${address}/"]`)).toHaveCount(0);
});
