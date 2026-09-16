import {
  test,
  expect,
  type Locator,
  type Page,
  type Route,
} from "@playwright/test";

/**
 * The web server these tests drive runs with the read API switched off, so the
 * history route answers its own 503. The pages below stand in for the
 * explorer's answer, shaped exactly like the merged contract in
 * `apps/api/README.md` and carrying the rows the panel has to render honestly:
 * a pending transaction, a failed one, a contract creation, an undecoded
 * method, an ERC-721 transfer and a token with no decimals.
 */
const wallet = "0x474583e46d2ea052fb5690bdebdb41d6cf1ebce1";
const hex = (n: number, size: number) =>
  `0x${n.toString(16).padStart(size, "0")}`;
const counterparty = (n: number) => hex(n + 0x1000, 40);
const cursor = (kind: string, page: number) => `cursor${kind}${page}`;
const pages = 3;

function transactions(page: number) {
  const items = Array.from({ length: 50 }, (_, index) => {
    const n = page * 50 + index;
    const pending = n === 0;
    return {
      hash: hex(n + 1, 64),
      block: pending ? null : 900000 - n,
      timestamp: pending ? null : 1789480000 - n * 60,
      from: wallet,
      to: n === 2 ? null : counterparty(n % 4),
      method: n === 3 ? null : n === 4 ? "0x095ea7b3" : "execute",
      status: pending ? "pending" : n === 1 ? "error" : "ok",
      value: n % 2 ? "16300000000000000" : "0",
      fee: pending ? null : "6790328640000",
    };
  });
  return body("transactions", items, page);
}
function transfers(page: number) {
  const items = Array.from({ length: 50 }, (_, index) => {
    const n = page * 50 + index;
    const nft = n === 1,
      undecimal = n === 2;
    return {
      transactionHash: hex(n + 1, 64),
      logIndex: n,
      block: 900000 - n,
      timestamp: 1789480000 - n * 60,
      from: wallet,
      to: counterparty(n % 4),
      token: {
        address: counterparty(9),
        symbol: nft ? null : undecimal ? "NODEC" : "STACK",
        name: nft ? null : "Stack Btc 7",
        decimals: nft || undecimal ? null : 18,
        type: nft ? "ERC-721" : "ERC-20",
      },
      value: nft ? null : undecimal ? "425000" : "539456082647569976419888",
      tokenId: nft ? "1234" : null,
      method: "0x3593564c",
    };
  });
  return body("token-transfers", items, page);
}
const body = (kind: string, items: unknown[], page: number) => ({
  source: "blockscout",
  chainId: 4663,
  wallet,
  kind,
  items,
  nextCursor: page + 1 < pages ? cursor(kind, page + 1) : null,
  fetchedAt: "2026-09-16T06:47:13.746Z",
  stale: false,
  note: "Explorer history for display only; not accounting or PnL evidence.",
});

/** Every history request the page made, in order. */
async function serveHistory(page: Page, requests: string[]) {
  await page.route("**/api/product/wallets/*/history/?**", async (route) => {
    const params = new URL(route.request().url()).searchParams;
    const kind = params.get("kind")!;
    const asked = params.get("cursor");
    requests.push(`${kind}:${asked ?? "first"}`);
    const index = asked ? Number(asked.slice(-1)) : 0;
    await route.fulfill({
      json: kind === "transactions" ? transactions(index) : transfers(index),
    });
  });
}
/** Both layouts are in the DOM; only the viewport's own one is on screen. */
const shown = (locator: Locator) => locator.filter({ visible: true }).first();
/** The rows of one tab, as a table on a desktop and as cards on a phone. */
const rowsOf = (page: Page, kind: string) =>
  page
    .locator(
      `[data-history="${kind}"] tbody tr, [data-history="${kind}"] article`,
    )
    .filter({ visible: true });

test("the explorer tabs page a wallet's own history without re-reading what is on screen", async ({
  page,
}) => {
  const requests: string[] = [];
  await serveHistory(page, requests);
  await page.goto(`/wallet/${wallet}/?window=All`);
  await expect(page.locator('[aria-busy="true"]:visible')).toHaveCount(0, {
    timeout: 20000,
  });
  // Explorer pages cost credits, so a closed tab must not have asked for one.
  expect(requests).toEqual([]);

  await page.getByRole("tab", { name: "Transactions", exact: true }).click();
  await expect(page).toHaveURL(/[?&]tab=transactions(&|$)/);
  const rows = rowsOf(page, "transactions");
  await expect(rows).toHaveCount(50);
  expect(requests).toEqual(["transactions:first"]);
  const panel = page.locator('[data-history="transactions"]');
  // Newest first, and a page that is only partly mined still reads honestly.
  await expect(
    shown(panel.getByText("Pending", { exact: true })),
  ).toBeVisible();
  await expect(shown(panel.getByText("Failed", { exact: true }))).toBeVisible();
  await expect(shown(panel.getByText("2026-09-15 13:45:40"))).toBeVisible();
  await expect(shown(panel.locator("sub"))).toHaveText("5");
  await expect(
    shown(panel.getByRole("link", { name: "Open transaction on explorer" })),
  ).toHaveAttribute(
    "href",
    `https://robinhoodchain.blockscout.com/tx/${hex(1, 64)}`,
  );
  await expect(
    shown(panel.getByRole("button", { name: "Copy transaction" })),
  ).toBeVisible();
  // The explorer's own caveat is for the captain, never for the screen.
  await expect(
    panel.getByText(/display only|accounting|coverage|methodology/i),
  ).toHaveCount(0);
  await expect(shown(page.getByText("via Blockscout"))).toBeVisible();

  // Load more appends the next page below, and never re-reads the first.
  await page.getByRole("button", { name: "Load more" }).click();
  await expect(rows).toHaveCount(100);
  expect(requests).toEqual([
    "transactions:first",
    `transactions:${cursor("transactions", 1)}`,
  ]);

  await page.getByRole("tab", { name: "Token transfers", exact: true }).click();
  await expect(page).toHaveURL(/[?&]tab=token-transfers(&|$)/);
  const transferRows = rowsOf(page, "token-transfers");
  await expect(transferRows).toHaveCount(50);
  const transferPanel = page.locator('[data-history="token-transfers"]');
  await expect(shown(transferPanel.getByText("STACK"))).toBeVisible();
  await expect(shown(transferPanel.getByText("539,456"))).toBeVisible();
  // No symbol means the token's own address; no decimals means the raw integer.
  await expect(
    shown(transferPanel.getByText("0x0000…1009", { exact: true })),
  ).toBeVisible();
  await expect(
    shown(transferPanel.getByText("#1234", { exact: true })),
  ).toBeVisible();
  await expect(
    shown(transferPanel.getByText("units", { exact: true })),
  ).toBeVisible();

  // Going back to a tab that already has its page must not spend another read.
  await page.getByRole("tab", { name: "Transactions", exact: true }).click();
  await expect(rows).toHaveCount(100);
  expect(requests).toHaveLength(3);
});

test("an unavailable explorer keeps its own state and its Retry-After", async ({
  page,
}) => {
  const answers: Route[] = [];
  await page.route("**/api/product/wallets/*/history/?**", async (route) => {
    answers.push(route);
    await route.fulfill({
      status: 503,
      headers: { "retry-after": "90" },
      json: { error: "wallet_history_unavailable", reason: "budget_exhausted" },
    });
  });
  await page.goto(`/wallet/${wallet}/?window=All&tab=transactions`);
  const panel = page.locator('[data-history="transactions"]');
  await expect(
    panel.getByText("Explorer history is unavailable right now."),
  ).toBeVisible();
  // Not one invented row, and the retry waits out the interval the API gave.
  await expect(rowsOf(page, "transactions")).toHaveCount(0);
  const retry = page.getByRole("button", { name: /Try again/ });
  await expect(retry).toBeDisabled();
  await expect(retry).toHaveText(/Try again in 1:[0-3]\d/);
  await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(0);
  expect(answers).toHaveLength(1);
});

test("an opened history tab holds its geometry as the page resolves", async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => {
    const state = { cls: 0 };
    Object.assign(window, { layoutMeasurement: state });
    new PerformanceObserver((list) => {
      for (const raw of list.getEntries()) {
        const shift = raw as PerformanceEntry & {
          hadRecentInput: boolean;
          value: number;
        };
        if (!shift.hadRecentInput) state.cls += shift.value;
      }
    }).observe({ type: "layout-shift", buffered: true });
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/product/wallets/*/history/?**", async (route) => {
    await gate;
    await route.fulfill({ json: transactions(0) });
  });
  await page.goto(`/wallet/${wallet}/?window=All&tab=transactions`, {
    waitUntil: "commit",
  });
  const region = page.locator('[data-history="transactions"]');
  await expect(region).toBeVisible();
  await expect(
    page.locator('[data-pending="true"]:visible').first(),
  ).toBeVisible();
  const reserved = await rowsOf(page, "transactions").count();
  expect(reserved, "the page in flight reserves its rows").toBe(50);
  const before = await region.boundingBox();
  const footerBefore = await page
    .getByRole("button", { name: "Load more" })
    .boundingBox();

  release();
  await expect(page.locator('[data-pending="true"]:visible')).toHaveCount(0);
  await expect(page.locator('[aria-busy="true"]:visible')).toHaveCount(0);
  await expect(rowsOf(page, "transactions")).toHaveCount(50);
  expect(await region.boundingBox()).toEqual(before);
  expect(
    await page.getByRole("button", { name: "Load more" }).boundingBox(),
  ).toEqual(footerBefore);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { layoutMeasurement: { cls: number } })
          .layoutMeasurement.cls,
    ),
    "cumulative layout shift",
  ).toBe(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    `the panel fits ${testInfo.project.name}`,
  ).toBe(true);
});
