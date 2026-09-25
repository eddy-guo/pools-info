import { test, expect, type Page } from "@playwright/test";
import type {
  FollowingTrade,
  FollowingTradesResponse,
  FollowingWalletCoverage,
} from "@pools/core";

const wallet = `0x${"1".repeat(40)}`;
const token = `0x${"2".repeat(40)}`;
const poolId = `0x${"3".repeat(64)}`;
const txHash = `0x${"4".repeat(64)}`;
const note =
  "Explorer history for display only; not accounting or PnL evidence." as const;

function coverage(
  address: string,
  status: FollowingWalletCoverage["status"] = "read",
): FollowingWalletCoverage {
  const read = status === "read" || status === "stale";
  return {
    wallet: address,
    status,
    fetchedAt: read ? "2026-09-25T21:44:28.479Z" : null,
    reason:
      status === "stale" || status === "unavailable"
        ? "upstream_unavailable"
        : null,
    olderTrades: read,
    horizonBlock: read ? 100 : null,
  };
}
function answer(
  items: FollowingTrade[],
  wallets: FollowingWalletCoverage[],
  generatedAt = "2026-09-25T21:44:36.065Z",
  hasMore = false,
): FollowingTradesResponse {
  return {
    source: "blockscout",
    scope: "explorer_registry_trades",
    items,
    hasMore,
    notice: "Each followed wallet's newest explorer trades.",
    note,
    coverage: {
      requestedWallets: wallets.length,
      returnedTokens: new Set(items.map((t) => t.token)).size,
      wallets,
      generatedAt,
      complete: false,
      registryExhaustive: false,
    },
  };
}
function trade(
  n: number,
  owner = wallet,
  patch: Partial<FollowingTrade> = {},
): FollowingTrade {
  const hash = `0x${n.toString(16).padStart(64, "4")}`;
  return {
    id: `${hash}:${n}`,
    wallet: owner,
    poolId,
    token,
    symbol: "TEST",
    name: "Test token",
    decimals: 18,
    txHash: hash,
    logIndex: n,
    block: 1000 - n,
    timestamp: 1789635351 - n * 60,
    side: n % 2 ? "buy" : "sell",
    tokenRaw: "204380635229317043485969",
    method: "0x3593564c",
    ...patch,
  };
}
type Measured = { cls: number; shifts: unknown[] };
const snapshot = answer(
  [trade(0, wallet, { id: `${txHash}:1`, txHash, logIndex: 1, side: "buy" })],
  [coverage(wallet)],
);

async function follow(page: Page, addresses: string[]) {
  await page.addInitScript(
    (list) =>
      localStorage.setItem("poolsinfo.following.v1", JSON.stringify(list)),
    addresses,
  );
}

test("followed activity keeps its trades on outage, pauses and replaces them with an empty answer", async ({
  page,
}, testInfo) => {
  await page.clock.install();
  await follow(page, [wallet]);
  let requests = 0;
  let release!: () => void;
  const first = new Promise<void>((resolve) => {
    release = resolve;
  });
  const rpc: string[] = [];
  page.on("request", (request) => {
    if (/alchemy|\/rpc(?:\/|$)/i.test(request.url())) rpc.push(request.url());
  });
  await page.route("**/api/product/following/?*", async (route) => {
    requests++;
    const params = new URL(route.request().url()).searchParams;
    expect(params.get("wallets")).toBe(wallet);
    expect(params.get("limit")).toBe("25");
    if (requests === 1) {
      await first;
      return route.fulfill({ json: snapshot });
    }
    if (requests === 2)
      return route.fulfill({
        status: 503,
        json: { error: "data_unavailable" },
      });
    return route.fulfill({
      json: answer([], [coverage(wallet)], "2026-09-25T21:46:00.000Z"),
    });
  });
  try {
    await page.goto("/wallet/");
    const feed = page.getByRole("region", {
      name: "Following activity",
      exact: true,
    });
    const table = feed.locator(".following-trades-table");
    const rows = feed.locator(
      testInfo.project.name === "mobile"
        ? ".mobile-wallet-row"
        : ".following-trades-table tbody tr",
    );
    await expect(rows).toHaveCount(25);
    await expect(rows.first()).toHaveAttribute("data-row", "reserved");
    await page.clock.fastForward(10000);
    expect(requests).toBe(1);
    release();
    await expect(rows.first()).toHaveAttribute("data-row", "resolved");
    await expect(rows).toHaveCount(25);
    const row = rows.first();
    await expect(row.getByText("Buy", { exact: true })).toBeVisible();
    await expect(row.getByRole("link", { name: "TEST" })).toHaveAttribute(
      "href",
      `/pool/${poolId}/`,
    );
    await expect(
      row.getByRole("link", { name: /0x1111…1111/ }),
    ).toHaveAttribute("href", `/wallet/${wallet}/`);
    await expect(row).toContainText("204,380.635229");
    await expect(
      row.getByRole("link", { name: /0x4444…4444/ }),
    ).toHaveAttribute(
      "href",
      `https://robinhoodchain.blockscout.com/tx/${txHash}`,
    );
    // The explorer's trade carries no ETH figure, and the panel shows none.
    if (testInfo.project.name !== "mobile")
      await expect(table.locator("thead th")).toHaveText([
        "Wallet",
        "Token",
        "Amount",
        "Time (UTC)",
        "Side",
        "Transaction",
      ]);
    await expect(feed).not.toContainText(/ETH|price|cutoff|coverage/i);
    await expect(feed.locator(".wallet-positions-context time")).toHaveText(
      "2026-09-25 21:44:36 UTC",
    );
    await feed.screenshot({
      path: testInfo.outputPath("following-activity.png"),
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.clock.fastForward(30000);
    await expect(feed.getByRole("alert")).toHaveText("Update failed");
    await expect(row.getByText("Buy", { exact: true })).toBeVisible();
    await feed.getByRole("button", { name: "Pause updates" }).click();
    await page.clock.fastForward(90000);
    expect(requests).toBe(2);
    await feed.getByRole("button", { name: "Resume updates" }).click();
    await page.clock.fastForward(30000);
    await expect(feed.getByText("No recent trades")).toBeVisible();
    await expect(feed.locator("[data-row=resolved]")).toHaveCount(0);
    expect(requests).toBe(3);
    await page.getByRole("button", { name: `Unfollow ${wallet}` }).click();
    await expect(feed).toHaveCount(0);
    await page.clock.fastForward(60000);
    expect(requests).toBe(3);
    expect(rpc).toEqual([]);
  } finally {
    release();
  }
});

test("a trade the explorer sent without symbol, decimals, time or pool invents none of them", async ({
  page,
}, testInfo) => {
  await follow(page, [wallet]);
  await page.route("**/api/product/following/?*", (route) =>
    route.fulfill({
      json: answer(
        [
          trade(0, wallet, {
            symbol: null,
            name: null,
            decimals: null,
            timestamp: null,
            poolId: null,
          }),
        ],
        [coverage(wallet)],
      ),
    }),
  );
  await page.goto("/wallet/");
  const feed = page.getByRole("region", { name: "Following activity" });
  const row = feed
    .locator(
      testInfo.project.name === "mobile"
        ? ".mobile-wallet-row"
        : ".following-trades-table tbody tr",
    )
    .first();
  await expect(row).toHaveAttribute("data-row", "resolved");
  // The token falls back to its shortened address, with no pool to link to.
  await expect(row.getByText("0x2222…2222", { exact: true })).toBeVisible();
  await expect(row.getByRole("link", { name: "0x2222…2222" })).toHaveCount(0);
  // No decimals: no amount is guessed; no block time: no time is shown.
  await expect(row).not.toContainText("204,380");
  await expect(row).not.toContainText("204380635229317043485969");
  await expect(row).not.toContainText("UTC");
  // The table keeps both cells wordless; the phone row drops the time.
  await expect(row.locator(".unavailable")).toHaveCount(
    testInfo.project.name === "mobile" ? 1 : 2,
  );
});

test("a wallet the feed has not read yet reads as loading, an unavailable one as unavailable", async ({
  page,
}) => {
  const pending = `0x${"5".repeat(40)}`;
  const failed = `0x${"6".repeat(40)}`;
  await follow(page, [wallet, pending, failed]);
  await page.route("**/api/product/following/?*", (route) =>
    route.fulfill({
      json: answer(
        [trade(0)],
        [
          coverage(wallet),
          coverage(pending, "pending"),
          coverage(failed, "unavailable"),
        ],
      ),
    }),
  );
  await page.goto("/wallet/");
  const list = page.getByRole("region", { name: "Followed wallets" });
  const item = (address: string) =>
    list.getByRole("listitem").filter({ hasText: address });
  await expect(item(pending).getByText("Loading")).toHaveAttribute(
    "data-pending",
    "true",
  );
  await expect(item(failed).getByText("Unavailable")).toBeVisible();
  await expect(item(wallet)).not.toContainText(/Loading|Unavailable/);
  // Rows past the read wallets' trades stay reserved as loading slots.
  const feed = page.getByRole("region", { name: "Following activity" });
  await expect(feed.getByText("No recent trades")).toHaveCount(0);
  await expect(feed.locator("[aria-busy=true]")).toHaveCount(2);
});

test("an explorer outage for every followed wallet is the panel's unavailable state", async ({
  page,
}) => {
  await follow(page, [wallet]);
  await page.route("**/api/product/following/?*", (route) =>
    route.fulfill({
      status: 503,
      headers: { "Retry-After": "30" },
      json: { error: "data_unavailable" },
    }),
  );
  await page.goto("/wallet/");
  const feed = page.getByRole("region", { name: "Following activity" });
  await expect(
    feed.getByRole("heading", { name: "Following activity unavailable" }),
  ).toBeVisible();
  await expect(feed.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(feed.locator("[data-row]")).toHaveCount(0);
});

for (const viewport of [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
])
  test(`polling a real follow list every 30 seconds never moves anything at ${viewport.width}`, async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name === "mobile" && viewport.width > 500,
      "The phone project covers the phone width only",
    );
    const followed = Array.from(
      { length: 12 },
      (_, i) => `0x${(i + 1).toString(16).padStart(2, "0").repeat(20)}`,
    ).sort();
    await page.setViewportSize(viewport);
    await page.clock.install();
    await follow(page, followed);
    await page.addInitScript(() => {
      const state = { cls: 0, shifts: [] as unknown[] };
      Object.assign(window, { layoutMeasurement: state });
      new PerformanceObserver((list) => {
        for (const raw of list.getEntries()) {
          const shift = raw as PerformanceEntry & {
            hadRecentInput: boolean;
            value: number;
            sources?: {
              node?: Node | null;
              previousRect: DOMRectReadOnly;
              currentRect: DOMRectReadOnly;
            }[];
          };
          if (shift.hadRecentInput) continue;
          state.cls += shift.value;
          state.shifts.push({
            value: shift.value,
            sources: shift.sources?.map((s) => ({
              node:
                s.node instanceof Element
                  ? `${s.node.tagName}.${[...s.node.classList].join(".")}`
                  : s.node?.nodeName,
              previous: s.previousRect.toJSON(),
              current: s.currentRect.toJSON(),
            })),
          });
        }
      }).observe({ type: "layout-shift", buffered: true });
    });
    let poll = 0;
    // Each answer is what the api sends as it reads the list eight wallets at
    // a time: the first leaves four pending, later ones add newer trades at
    // the top and push older ones down, one refresh fails, and hasMore
    // arrives once the list is full.
    await page.route("**/api/product/following/?*", (route) => {
      poll++;
      if (poll === 4)
        return route.fulfill({
          status: 503,
          json: { error: "data_unavailable" },
        });
      const read = poll === 1 ? followed.slice(0, 8) : followed;
      const items = read
        .flatMap((address, w) =>
          // A wallet's trades keep their ids from poll to poll; each poll
          // adds one newer trade per wallet above the ones already listed.
          Array.from({ length: poll + 1 }, (_, seq) =>
            trade(1000 * w + seq, address, {
              block: 5000 + seq * 100 - w * 3,
              timestamp: 1789635351 + seq * 60 - w,
              symbol: w % 3 === 2 ? null : `TOKEN${w}`,
              decimals: w % 5 === 4 ? null : 18,
              tokenRaw: String(10n ** BigInt(18 + (w % 7)) * BigInt(seq + 1)),
            }),
          ),
        )
        .sort((a, b) => b.block - a.block)
        .slice(0, 25);
      return route.fulfill({
        json: answer(
          items,
          followed.map((address) =>
            coverage(address, read.includes(address) ? "read" : "pending"),
          ),
          new Date(Date.UTC(2026, 8, 25, 21, 44, poll * 7)).toISOString(),
          poll > 1,
        ),
      });
    });
    await page.goto("/wallet/");
    const feed = page.getByRole("region", { name: "Following activity" });
    const stamp = feed.locator(".wallet-positions-context time");
    await expect(stamp).toHaveText("2026-09-25 21:44:07 UTC");
    // What a reader watches: the panel in view while the feed refreshes.
    await feed.locator(".wallet-positions-context").scrollIntoViewIfNeeded();
    await page.evaluate(() => {
      const state = (window as unknown as { layoutMeasurement: Measured })
        .layoutMeasurement;
      state.cls = 0;
      state.shifts = [];
    });
    for (let tick = 2; tick <= 6; tick++) {
      await page.clock.fastForward(30000);
      await expect.poll(() => poll).toBe(tick);
      if (tick === 4)
        await expect(feed.getByRole("alert")).toHaveText("Update failed");
      else
        await expect(stamp).toHaveText(
          `2026-09-25 21:44:${String(tick * 7).padStart(2, "0")} UTC`,
        );
    }
    await expect(feed.getByText(/Newest 25 shown/)).toBeVisible();
    await expect(
      page
        .getByRole("region", { name: "Followed wallets" })
        .getByText("Loading"),
    ).toHaveCount(0);
    const measured = await page.evaluate(
      () =>
        (window as unknown as { layoutMeasurement: Measured })
          .layoutMeasurement,
    );
    await feed.screenshot({
      path: testInfo.outputPath(`following-activity-${viewport.width}.png`),
    });
    expect(measured.cls, JSON.stringify(measured.shifts)).toBeLessThan(0.001);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
