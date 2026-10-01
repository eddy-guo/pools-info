import { test, expect, type Page, type TestInfo } from "@playwright/test";
import chain from "../../data/snapshots/chain.json";
import type {
  FollowingTrade,
  FollowingTradesResponse,
  FollowingWalletCoverage,
} from "@pools/core";

/**
 * The You page (`/you/`): everything this browser saved for itself, read
 * from the same localStorage stores every follow button and star write; the
 * header entry that leads to it; and the confirmation every star and follow
 * raises. The reads behind the page are mocked where they are billed (the
 * Following feed is an explorer read) and left to the fixture deployment
 * where they are not (the watchlist's explore read, the followed wallets'
 * summaries). The bar is the site's: nothing moves after first paint, at
 * 1440 and at 390, with the served shell sized by the pre-paint script and
 * hydration landing the lists on that geometry.
 */

/** The fixture's top-ranked trader, and a wallet the fixture never saw. */
const wallet = "0x474583e46d2ea052fb5690bdebdb41d6cf1ebce1";
const other = "0x1111111111111111111111111111111111111111";
const short = (address: string) =>
  `${address.slice(0, 6)}…${address.slice(-4)}`;
/* Uniquely-named fixture pools: the dataset repeats "MonkiiLabs" across two
   entries, which a name-text filter cannot tell apart. */
const pools = [chain.markets[1], chain.markets[4], chain.markets[7]];
const followingKey = "poolsinfo.following.v1";
const watchlistKey = "poolsinfo.watchlist.v1";
const myWalletKey = "poolsinfo.my-wallet.v1";

function coverage(address: string): FollowingWalletCoverage {
  return {
    wallet: address,
    status: "read",
    fetchedAt: "2026-09-25T21:44:28.479Z",
    reason: null,
    olderTrades: true,
    horizonBlock: 100,
  };
}
/** One buy by the fixture wallet in a fixture pool, two hours before now. */
function trade(): FollowingTrade {
  const pool = pools[1];
  return {
    id: `0x${"4".repeat(64)}:1`,
    wallet,
    poolId: pool.id,
    token: pool.token,
    symbol: pool.symbol,
    name: pool.name,
    decimals: 18,
    txHash: `0x${"4".repeat(64)}`,
    logIndex: 1,
    block: 1000,
    timestamp: Math.floor(Date.now() / 1000) - 7200,
    side: "buy",
    tokenRaw: "204380635229317043485969",
    method: "0x3593564c",
  };
}
/** The feed's answer for whatever wallets the page asked about: the one
    trade above where the fixture wallet is among them, every wallet read. */
function feedAnswer(requested: string[]): FollowingTradesResponse {
  const wallets = [...requested].sort();
  const items = wallets.includes(wallet) ? [trade()] : [];
  return {
    source: "blockscout",
    scope: "explorer_registry_trades",
    items,
    hasMore: false,
    notice: "Each followed wallet's newest explorer trades.",
    note: "Explorer history for display only; not accounting or PnL evidence.",
    coverage: {
      requestedWallets: wallets.length,
      returnedTokens: new Set(items.map((t) => t.token)).size,
      wallets: wallets.map(coverage),
      generatedAt: "2026-09-25T21:44:36.065Z",
      complete: false,
      registryExhaustive: false,
    },
  };
}
function mockFeed(page: Page) {
  const requests: string[] = [];
  return {
    requests,
    install: () =>
      page.route("**/api/product/following/?*", (route) => {
        const url = new URL(route.request().url());
        requests.push(url.href);
        return route.fulfill({
          json: feedAnswer((url.searchParams.get("wallets") ?? "").split(",")),
        });
      }),
  };
}
/** Every product read this session makes, as its path and query. */
function productRequests(page: Page) {
  const urls: URL[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/product/")) urls.push(url);
  });
  return urls;
}
async function seed(
  page: Page,
  stores: { following?: string[]; watchlist?: string[]; myWallet?: string },
) {
  await page.addInitScript(
    ({ stores, followingKey, watchlistKey, myWalletKey }) => {
      if (stores.following)
        localStorage.setItem(followingKey, JSON.stringify(stores.following));
      if (stores.watchlist)
        localStorage.setItem(watchlistKey, JSON.stringify(stores.watchlist));
      if (stores.myWallet) localStorage.setItem(myWalletKey, stores.myWallet);
    },
    { stores, followingKey, watchlistKey, myWalletKey },
  );
}
type Measured = { cls: number; sources: string[] };
/** Installed before navigation, as the layout-shift API requires; each
    shift is kept with the nodes that moved, so a failure names them. */
async function installClsObserver(page: Page) {
  await page.addInitScript(() => {
    const state: Measured = { cls: 0, sources: [] };
    Object.assign(window, { layoutMeasurement: state });
    const describe = (node: Node | null) => {
      const element = node as Element | null;
      if (!element?.tagName) return String(node?.nodeName ?? "(detached)");
      return `${element.tagName.toLowerCase()}.${[...element.classList].join(".")}`;
    };
    const box = (rect: DOMRectReadOnly) =>
      `[${Math.round(rect.x)},${Math.round(rect.y)} ${Math.round(rect.width)}x${Math.round(rect.height)}]`;
    new PerformanceObserver((list) => {
      for (const raw of list.getEntries()) {
        const shift = raw as PerformanceEntry & {
          hadRecentInput: boolean;
          value: number;
          sources?: {
            node: Node | null;
            previousRect: DOMRectReadOnly;
            currentRect: DOMRectReadOnly;
          }[];
        };
        if (shift.hadRecentInput) continue;
        state.cls += shift.value;
        state.sources.push(
          `${shift.value}: ` +
            (shift.sources ?? [])
              .map(
                (s) =>
                  `${describe(s.node)} ${box(s.previousRect)} to ${box(s.currentRect)}`,
              )
              .join(", "),
        );
      }
    }).observe({ type: "layout-shift", buffered: true });
  });
}
const measured = (page: Page) =>
  page.evaluate(async () => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    return (window as unknown as { layoutMeasurement: Measured })
      .layoutMeasurement;
  });
const resetCls = (page: Page) =>
  page.evaluate(() => {
    const state = (window as unknown as { layoutMeasurement: Measured })
      .layoutMeasurement;
    state.cls = 0;
    state.sources = [];
  });
/** The rectangles of everything that stacks down the page, visible ones
    only, so a hidden pre-hydration shell never enters the comparison. */
const stackRects = (page: Page) =>
  page.evaluate(async () => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    return [
      ...document.querySelectorAll(
        ".page-heading, .you-identity, .you-section-head, .you-panel, .following-activity, .footer",
      ),
    ]
      .map((node) => {
        const rect = node.getBoundingClientRect();
        return {
          node: `${node.tagName.toLowerCase()}.${[...node.classList].join(".")}`,
          top: Math.round(rect.top * 100) / 100,
          height: Math.round(rect.height * 100) / 100,
        };
      })
      .filter((rect) => rect.height > 0);
  });
const phone = (testInfo: TestInfo) => testInfo.project.name === "mobile";
/** The phone project measures the brief's 390px, not the Pixel 7's 412. */
async function viewport(page: Page, testInfo: TestInfo) {
  if (phone(testInfo)) await page.setViewportSize({ width: 390, height: 844 });
}
const entry = (page: Page) => page.locator(".header-actions .connect-button");
const badge = (page: Page) => entry(page).locator(".connect-count");
const toast = (page: Page) => page.locator(".saved-toast");
const watchRows = (page: Page, testInfo: TestInfo) =>
  page.locator(
    phone(testInfo)
      ? "#watchlist .mobile-pools .mobile-pool[data-row]"
      : "#watchlist .desktop-pools tbody tr[data-row]",
  );
const followedRows = (page: Page) =>
  page.getByRole("list", { name: "Followed wallets" }).getByRole("listitem");
const screenerRows = (page: Page, testInfo: TestInfo) =>
  page.locator(
    phone(testInfo)
      ? ".explore-page .mobile-pools .mobile-pool[data-row='resolved']"
      : ".explore-page .desktop-pools tbody tr[data-row='resolved']",
  );

test("with nothing saved, the page teaches how to star and follow, reads nothing, and offers no sign-in", async ({
  page,
}, testInfo) => {
  await viewport(page, testInfo);
  await installClsObserver(page);
  const requests = productRequests(page);
  await page.goto("/you/");
  await page.waitForLoadState("networkidle");
  const main = page.locator("main");
  await expect(main.locator("h1")).toHaveText("You.");
  await expect(main.locator(".eyebrow")).toHaveText("SAVED ON THIS DEVICE");
  await expect(main.locator(".page-heading p")).toHaveText(
    "Your watchlist and follows live in this browser only, with no account and nothing stored anywhere else.",
  );
  // The lede is the one device sentence; no section repeats it.
  await expect(main.getByText(/saved (only )?in this browser/i)).toHaveCount(0);
  const identity = page.locator(".you-identity");
  await expect(identity).toContainText("YOU");
  await expect(identity).toContainText(
    "Set your wallet to see your rank and portfolio here",
  );
  await expect(
    identity.getByRole("button", { name: "Set my wallet" }),
  ).toBeVisible();
  const watchlist = page.getByRole("region", { name: "Watchlist" });
  await expect(
    watchlist.getByRole("heading", { name: "Your watchlist starts here" }),
  ).toBeVisible();
  await expect(watchlist).toContainText("Star a pool anywhere on Pools");
  await expect(
    watchlist.getByRole("link", { name: "Browse pools" }),
  ).toHaveAttribute("href", "/");
  await expect(
    watchlist.getByRole("link", { name: "Open in screener" }),
  ).toHaveAttribute("href", "/?view=watchlist&window=All&sort=launch");
  const following = page.getByRole("region", { name: "Following" });
  await expect(
    following.getByRole("heading", {
      name: "You are not following anyone yet",
    }),
  ).toBeVisible();
  await expect(following).toContainText(
    "Follow a wallet from the leaderboard or a wallet page",
  );
  await expect(
    following.getByRole("link", { name: "Open the leaderboard" }),
  ).toHaveAttribute("href", "/traders/");
  await expect(
    following.getByRole("link", { name: "Compare on the leaderboard" }),
  ).toHaveAttribute("href", "/traders/?view=following");
  // Local only: no account, no connection, no promise of one.
  await expect(main).not.toContainText(
    /sign in|sign-in|log in|connect|coming soon/i,
  );
  // Nothing to list means nothing to read: the feed is a billed read.
  expect(
    requests
      .map((url) => url.pathname)
      .filter((path) => !path.startsWith("/api/product/prices/")),
    "no list read for empty lists",
  ).toEqual([]);
  // The header entry leads here, names the empty state, and shows no count.
  await expect(entry(page)).toHaveAttribute("href", "/you/");
  await expect(entry(page)).toHaveAccessibleName("You: nothing saved yet");
  await expect(entry(page)).toHaveAttribute("aria-current", "page");
  await expect(badge(page)).toHaveCount(0);
  const result = await measured(page);
  expect(result.cls, result.sources.join("\n")).toBeLessThan(0.001);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("you-empty.png"),
    fullPage: true,
  });
});

test("with saved wallets and pools, every section paints at its final height before the reads land, lists them, and unstar or unfollow leaves a row with an Undo and no read", async ({
  page,
}, testInfo) => {
  await viewport(page, testInfo);
  await installClsObserver(page);
  await seed(page, {
    following: [wallet, other],
    watchlist: pools.map((p) => p.id),
    myWallet: wallet,
  });
  const feed = mockFeed(page);
  await feed.install();
  const requests = productRequests(page);
  /* The served shell first, alone: scripts wait until its geometry is
     measured, so hydration and every read land on a page already sized. */
  let releaseScripts!: () => void;
  const scripts = new Promise<void>((resolve) => {
    releaseScripts = resolve;
  });
  await page.route("**/_next/static/**/*.js", async (route) => {
    await scripts;
    await route.continue();
  });
  await page.goto("/you/", { waitUntil: "commit" });
  await expect(page.locator(".you-identity")).toBeVisible();
  // The pre-paint script sized both sections from the seeded lists.
  await expect(page.locator("html")).toHaveAttribute(
    "data-you-following",
    "some",
  );
  await expect(page.locator("html")).toHaveAttribute(
    "data-you-watchlist",
    "some",
  );
  const before = await stackRects(page);
  await page.screenshot({
    path: testInfo.outputPath("you-populated-pending.png"),
    fullPage: true,
  });
  releaseScripts();
  await expect(watchRows(page, testInfo).first()).toHaveAttribute(
    "data-row",
    "resolved",
  );
  await expect(page.locator('[aria-busy="true"]:visible')).toHaveCount(0);
  await expect(page.locator('[data-pending="true"]:visible')).toHaveCount(0);
  await page.waitForLoadState("networkidle");
  const after = await stackRects(page);
  expect(after, "nothing below the heading moved as the lists landed").toEqual(
    before,
  );
  const result = await measured(page);
  expect(result.cls, result.sources.join("\n")).toBeLessThan(0.001);

  // The identity row: the marked wallet's rank, its portfolio, its forget.
  const identity = page.locator(".you-identity");
  await expect(identity).toContainText(short(wallet));
  await expect(identity).toContainText(/YOU · RANK \d+/);
  await expect(identity).toContainText(/realized .*ETH across \d+ trades/);
  await expect(
    identity.getByRole("link", { name: /Portfolio/ }),
  ).toHaveAttribute("href", `/wallet/${wallet}/?window=7d`);
  await expect(
    identity.getByRole("button", { name: "Forget this wallet" }),
  ).toBeVisible();

  // The watchlist: read by identity in launch order over the whole history,
  // never through a window metric that would drop a quiet pool.
  const watchReads = requests.filter(
    (url) => url.pathname === "/api/product/explore/",
  );
  expect(watchReads).toHaveLength(1);
  expect(Object.fromEntries(watchReads[0].searchParams)).toMatchObject({
    view: "watchlist",
    window: "All",
    sort: "launch",
    direction: "desc",
    ids: pools.map((p) => p.id).join(","),
  });
  await expect(page.locator("#you-watchlist-heading")).toHaveText(
    "Watchlist (3)",
  );
  await expect(watchRows(page, testInfo)).toHaveCount(3);
  for (const pool of pools) {
    const row = watchRows(page, testInfo).filter({ hasText: pool.name });
    await expect(row).toHaveAttribute("data-row", "resolved");
    expect(await row.locator("a.token-cell").getAttribute("href")).toContain(
      `/pool/${pool.id}/`,
    );
    await expect(row.locator(".price")).toContainText("ETH");
    await expect(row.locator(".change, .change-age")).toHaveCount(1);
    await expect(row.locator("button.watch")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  }
  await expect(page.locator("#watchlist .pagination-count")).toHaveText(
    "Showing 3 of 3",
  );
  await expect(
    page.locator("#watchlist").getByRole("button", {
      name: "Copy watchlist link",
    }),
  ).toBeEnabled();

  // Following: each wallet's identity, its 7d summary, the feed below.
  await expect(page.locator("#you-following-heading")).toHaveText(
    "Following (2)",
  );
  const rows = followedRows(page);
  await expect(rows).toHaveCount(2);
  await expect(
    rows.nth(0).getByRole("link", { name: new RegExp(short(wallet)) }),
  ).toHaveAttribute("href", `/wallet/${wallet}/`);
  await expect(rows.nth(0)).toContainText(/realized .*ETH · \d+ trades/);
  await expect(rows.nth(1)).toContainText(short(other));
  await expect(rows.nth(1)).toContainText(/no trades in 7d|unavailable/);
  const activity = page.getByRole("region", { name: "Following activity" });
  await expect(
    activity.locator("[data-row='resolved']").first(),
  ).toBeAttached();
  expect(feed.requests, "one feed read for the whole list").toHaveLength(1);
  expect(new URL(feed.requests[0]).searchParams.get("wallets")).toBe(
    [wallet, other].sort().join(","),
  );
  await expect(badge(page)).toHaveText("5");
  await expect(entry(page)).toHaveAccessibleName("You: 3 watched, 2 followed");
  await page.screenshot({
    path: testInfo.outputPath("you-populated.png"),
    fullPage: true,
  });

  // Unstar: the row leaves at once, nothing is read again for it, the note
  // offers Undo, and Undo brings the row back from the list on hand.
  const exploreReads = () =>
    requests.filter((url) => url.pathname === "/api/product/explore/").length;
  const readsBefore = exploreReads();
  const gone = pools[2];
  await watchRows(page, testInfo)
    .filter({ hasText: gone.name })
    .locator("button.watch")
    .click();
  await expect(
    watchRows(page, testInfo).filter({ hasText: gone.name }),
  ).toHaveCount(0);
  await expect(page.locator("#watchlist .pagination-count")).toHaveText(
    "Showing 2 of 2",
  );
  await expect(page.locator("#you-watchlist-heading")).toHaveText(
    "Watchlist (2)",
  );
  await expect(badge(page)).toHaveText("4");
  await expect(toast(page)).toContainText("Removed from your watchlist");
  await toast(page).getByRole("button", { name: "Undo" }).click();
  await expect(toast(page)).toHaveCount(0);
  await expect(
    watchRows(page, testInfo).filter({ hasText: gone.name }),
  ).toHaveAttribute("data-row", "resolved");
  await expect(page.locator("#watchlist .pagination-count")).toHaveText(
    "Showing 3 of 3",
  );
  await expect(badge(page)).toHaveText("5");
  expect(exploreReads(), "unstarring and undoing ask explore nothing").toBe(
    readsBefore,
  );

  // Unfollow the same way.
  await rows
    .nth(1)
    .getByRole("button", { name: `Unfollow ${other}` })
    .click();
  await expect(followedRows(page)).toHaveCount(1);
  await expect(page.locator("#you-following-heading")).toHaveText(
    "Following (1)",
  );
  await expect(badge(page)).toHaveText("4");
  await expect(toast(page)).toContainText(`Unfollowed ${short(other)}`);
  await toast(page).getByRole("button", { name: "Undo" }).click();
  await expect(followedRows(page)).toHaveCount(2);
  await expect(badge(page)).toHaveText("5");
  await expect(entry(page)).toHaveAccessibleName("You: 3 watched, 2 followed");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("a feed outage keeps the followed wallets and collapses the feed to its retry control", async ({
  page,
}, testInfo) => {
  await viewport(page, testInfo);
  await seed(page, { following: [wallet, other] });
  await page.route("**/api/product/following/?*", (route) =>
    route.fulfill({
      status: 503,
      headers: { "Retry-After": "30" },
      json: { error: "data_unavailable" },
    }),
  );
  await page.goto("/you/");
  await expect(followedRows(page)).toHaveCount(2);
  // The feed's word on each wallet is nothing when the whole feed failed
  // (the feed says so below); the 7d summaries are their own reads.
  await expect(followedRows(page).nth(0)).not.toContainText("Loading");
  await expect(followedRows(page).nth(0)).toContainText(
    /realized .*ETH · \d+ trades|no trades in 7d|unavailable/,
  );
  const activity = page.getByRole("region", { name: "Following activity" });
  await expect(
    activity.getByRole("heading", { name: "Following activity unavailable" }),
  ).toBeVisible();
  await expect(
    activity.getByRole("button", { name: "Try again" }),
  ).toBeVisible();
});

test("starring on the screener confirms with a View link that lands on the watchlist here, moves the header count without moving the header, and respects reduced motion", async ({
  page,
}, testInfo) => {
  await viewport(page, testInfo);
  await installClsObserver(page);
  await page.clock.install();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  const rows = screenerRows(page, testInfo);
  await expect(rows.first()).toBeAttached();
  await expect(page.locator('[aria-busy="true"]:visible')).toHaveCount(0);
  const entryBox = (await entry(page).boundingBox())!;
  const headerBox = (await page.locator(".site-header").boundingBox())!;
  await resetCls(page);
  const region = page.locator(".saved-toast-region");
  await expect(region).toHaveAttribute("role", "status");
  await expect(region).toHaveAttribute("aria-live", "polite");
  await expect(toast(page)).toHaveCount(0);

  const first = rows.first();
  const name = (await first.locator(".token-cell strong").innerText()).trim();
  await first.locator("button.watch").click();
  await expect(toast(page)).toBeVisible();
  await expect(region).toContainText("Added to your watchlist");
  await expect(toast(page).getByRole("link", { name: "View" })).toHaveAttribute(
    "href",
    "/you/#watchlist",
  );
  await expect(toast(page)).toHaveCSS("animation-name", "saved-toast-fade");
  await expect(badge(page)).toHaveText("1");
  await expect(entry(page)).toHaveAccessibleName("You: 1 watched, 0 followed");
  expect(await entry(page).boundingBox(), "the entry keeps its box").toEqual(
    entryBox,
  );
  expect(await page.locator(".site-header").boundingBox()).toEqual(headerBox);
  // The note stays while a pointer rests on it, and four seconds after it leaves.
  await toast(page).hover();
  await page.clock.fastForward(6000);
  await expect(toast(page)).toBeVisible();
  await page.mouse.move(10, 300);
  await page.clock.fastForward(3500);
  await expect(toast(page)).toBeVisible();
  await page.clock.fastForward(1000);
  await expect(toast(page)).toHaveCount(0);
  // Escape dismisses the next one.
  await rows.nth(1).locator("button.watch").click();
  await expect(toast(page)).toBeVisible();
  await expect(badge(page)).toHaveText("2");
  await page.keyboard.press("Escape");
  await expect(toast(page)).toHaveCount(0);
  const result = await measured(page);
  expect(result.cls, result.sources.join("\n")).toBe(0);
  // View lands on the list, with the pool in it.
  await first.locator("button.watch").click();
  await expect(first.locator("button.watch")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await expect(toast(page)).toContainText("Removed from your watchlist");
  await toast(page).getByRole("button", { name: "Undo" }).click();
  await expect(first.locator("button.watch")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await rows.nth(2).locator("button.watch").click();
  await toast(page).getByRole("link", { name: "View" }).click();
  await expect(page).toHaveURL(/\/you\/#watchlist$/);
  await expect(toast(page)).toHaveCount(0);
  await expect(page.locator("#you-watchlist-heading")).toHaveText(
    "Watchlist (3)",
  );
  await expect(
    watchRows(page, testInfo).filter({ hasText: name }),
  ).toHaveAttribute("data-row", "resolved");
  await expect(page.locator("main")).not.toContainText(/sign in|log in/i);
});

test("following from the leaderboard confirms with a View link that lands on the followed wallet here", async ({
  page,
  request,
}, testInfo) => {
  await viewport(page, testInfo);
  const feed = mockFeed(page);
  await feed.install();
  const payload = await (
    await request.get("/api/product/leaderboard/?window=7d")
  ).json();
  const address: string = payload.items[0].address;
  await page.goto("/traders/");
  const follow = page.getByRole("button", { name: `Follow ${address}` });
  await follow.hover();
  await follow.click();
  await expect(toast(page)).toContainText(`Following ${short(address)}`);
  await expect(badge(page)).toHaveText("1");
  await expect(entry(page)).toHaveAccessibleName("You: 0 watched, 1 followed");
  await toast(page).getByRole("button", { name: "Dismiss" }).click();
  await expect(toast(page)).toHaveCount(0);
  // Unfollowing confirms too, with Undo rather than a link. The toggle keeps
  // one name; its pressed state alone says whether the wallet is followed.
  await expect(follow).toHaveAttribute("aria-pressed", "true");
  await follow.click();
  await expect(toast(page)).toContainText(`Unfollowed ${short(address)}`);
  await expect(follow).toHaveAttribute("aria-pressed", "false");
  await expect(badge(page)).toHaveCount(0);
  await toast(page).getByRole("button", { name: "Undo" }).click();
  await expect(follow).toHaveAttribute("aria-pressed", "true");
  await expect(badge(page)).toHaveText("1");
  await follow.click();
  await expect(follow).toHaveAttribute("aria-pressed", "false");
  await follow.click();
  await expect(follow).toHaveAttribute("aria-pressed", "true");
  const link = toast(page).getByRole("link", { name: "View" });
  await expect(link).toHaveAttribute("href", "/you/#following");
  await link.click();
  await expect(page).toHaveURL(/\/you\/#following$/);
  await expect(toast(page)).toHaveCount(0);
  await expect(
    followedRows(page).getByRole("link", {
      name: new RegExp(short(address)),
    }),
  ).toHaveAttribute("href", `/wallet/${address}/`);
  await expect(page.locator("#you-following-heading")).toHaveText(
    "Following (1)",
  );
});

/* The header's freshness stamp is the page's own read cut: with nothing
   saved the page reads nothing and stamps nothing (shell.spec.ts); with
   something saved, each section's ledger read stamps its own cut, never the
   explorer feed's, which is not a ledger read. */
const stampNow = Date.UTC(2026, 8, 29, 12, 0, 0) / 1000;
for (const { name, stores, endpoint, lag, stamp } of [
  {
    name: "the watchlist",
    stores: { watchlist: pools.map((p) => p.id) },
    endpoint: "explore",
    lag: 30,
    stamp: "indexed 30s ago",
  },
  {
    name: "the followed wallets",
    stores: { following: [wallet, other] },
    endpoint: "wallets/",
    lag: 90,
    stamp: "indexed 1m ago",
  },
  {
    name: "the marked wallet",
    stores: { myWallet: wallet },
    endpoint: "wallets/",
    lag: 59,
    stamp: "indexed 59s ago",
  },
])
  test(`the header stamps the cut of ${name}'s read`, async ({ page }) => {
    await page.clock.setFixedTime(new Date(stampNow * 1000));
    await seed(page, stores);
    await page.route("**/api/product/**", async (route) => {
      const path = new URL(route.request().url()).pathname.slice(
        "/api/product/".length,
      );
      if (!path.startsWith(endpoint)) return route.fallback();
      const response = await route.fetch();
      // A wallet the fixture never saw answers unavailable, cut and all.
      if (!response.ok()) return route.fulfill({ response });
      const json = await response.json();
      json.coverage.asOf = stampNow - lag;
      return route.fulfill({ json });
    });
    await mockFeed(page).install();
    await page.goto("/you/");
    await expect(page.locator(".subnav-freshness")).toHaveText(stamp, {
      timeout: 15_000,
    });
  });

test("the header count follows both stores across a reload", async ({
  page,
  request,
}, testInfo) => {
  await viewport(page, testInfo);
  const feed = mockFeed(page);
  await feed.install();
  await page.goto("/");
  const rows = screenerRows(page, testInfo);
  await expect(rows.nth(1)).toBeAttached();
  await rows.nth(0).locator("button.watch").click();
  await rows.nth(1).locator("button.watch").click();
  await expect(badge(page)).toHaveText("2");
  const payload = await (
    await request.get("/api/product/leaderboard/?window=7d")
  ).json();
  const address: string = payload.items[0].address;
  await page.goto("/traders/");
  await expect(badge(page)).toHaveText("2");
  const follow = page.getByRole("button", { name: `Follow ${address}` });
  await follow.hover();
  await follow.click();
  await expect(badge(page)).toHaveText("3");
  await page.reload();
  await expect(badge(page)).toHaveText("3");
  await expect(entry(page)).toHaveAccessibleName("You: 2 watched, 1 followed");
  await page.goto("/you/");
  await expect(page.locator("#you-watchlist-heading")).toHaveText(
    "Watchlist (2)",
  );
  await expect(page.locator("#you-following-heading")).toHaveText(
    "Following (1)",
  );
});

/* The count mounts at hydration, after a served header that painted none;
   whatever else the page does as it loads, nothing inside the header may
   move for it. Exact, not the page-wide 0.001 noise floor: a label pushed
   aside by the badge scored 0.0000077 at 1440. */
for (const marked of [false, true])
  test(`a saved count mounts without moving anything in the header${marked ? " beside the wallet chip" : ""}`, async ({
    page,
  }, testInfo) => {
    await viewport(page, testInfo);
    await seed(page, {
      watchlist: pools.map((p) => p.id),
      following: [other],
      ...(marked ? { myWallet: wallet } : {}),
    });
    await page.addInitScript(() => {
      const moved: string[] = [];
      Object.assign(window, { headerShifts: moved });
      new PerformanceObserver((list) => {
        for (const raw of list.getEntries()) {
          const shift = raw as PerformanceEntry & {
            sources?: { node: Node | null }[];
          };
          for (const source of shift.sources ?? []) {
            const element =
              source.node instanceof Element
                ? source.node
                : (source.node?.parentElement ?? null);
            if (element?.closest(".site-header"))
              moved.push(
                `${element.tagName.toLowerCase()}.${[...element.classList].join(".")}`,
              );
          }
        }
      }).observe({ type: "layout-shift", buffered: true });
    });
    await page.goto("/traders/");
    await expect(badge(page)).toHaveText("4");
    const moved = await page.evaluate(async () => {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      return (window as unknown as { headerShifts: string[] }).headerShifts;
    });
    expect(moved, "no header node moves as the count mounts").toEqual([]);
  });

test("the header entry with a three-character count still fits a 320px screen at the 390px header height", async ({
  page,
}, testInfo) => {
  test.skip(!phone(testInfo), "a 320px screen is the phone project's");
  const ids = Array.from(
    { length: 120 },
    (_, i) => `0x${(i + 1).toString(16).padStart(64, "0")}`,
  );
  await seed(page, { watchlist: ids, following: [wallet, other] });
  const measure = () =>
    page.evaluate(async () => {
      await document.fonts.ready;
      const header = document
        .querySelector(".site-header")!
        .getBoundingClientRect();
      const count = document
        .querySelector(".connect-count")!
        .getBoundingClientRect();
      const problems: string[] = [];
      for (const selector of [
        ".brand > span",
        ".header-actions .search-trigger",
        ".header-actions .unit-toggle",
      ]) {
        const rect = document.querySelector(selector)!.getBoundingClientRect();
        if (
          count.left < rect.right &&
          rect.left < count.right &&
          count.top < rect.bottom &&
          rect.top < count.bottom
        )
          problems.push(`the count overlaps ${selector}`);
      }
      if (count.right > innerWidth || count.left < 0)
        problems.push("the count leaves the viewport");
      if (count.top < header.top || count.bottom > header.bottom)
        problems.push("the count leaves the header");
      return {
        problems,
        height: header.height,
        text: document.querySelector(".connect-count")!.textContent,
      };
    });
  await page.setViewportSize({ width: 390, height: 640 });
  await page.goto("/");
  /* The count is this browser's own, so it mounts at hydration; a slow
     runner reaches the measurement before it does. */
  await expect(badge(page)).toHaveText("99+");
  const wide = await measure();
  expect(wide.text).toBe("99+");
  expect(wide.problems).toEqual([]);
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto("/");
  await expect(badge(page)).toHaveText("99+");
  const narrow = await measure();
  expect(narrow.problems).toEqual([]);
  expect(narrow.height).toBe(wide.height);
});
