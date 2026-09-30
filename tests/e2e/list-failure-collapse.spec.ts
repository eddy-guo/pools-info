import { test, expect, type Page } from "@playwright/test";

/**
 * The shared pending-then-failed contract for a growable list: creators,
 * traders, the screener and the wallet's positions all reserve rows while a
 * first read is genuinely pending, and the retry control lands right under
 * the list heading once the read fails, never a screen (or several, at
 * 390px) of blank rows below it. The lists over one counted answer
 * (`answeredRowCount` in `apps/web/src/components/product-common.tsx`: the
 * creators board and the screener) keep their reserved geometry and overlay
 * the failed state on its top, so nothing under them moves; the trader
 * leaderboard (`reservedRowCount`) still collapses its reservation.
 */
const wallet = "0x474583e46d2ea052fb5690bdebdb41d6cf1ebce1";

type ListCase = {
  name: string;
  url: string;
  apiPattern: string;
  subject: string;
  rows: (page: Page) => ReturnType<Page["locator"]>;
  panel: (page: Page) => ReturnType<Page["locator"]>;
  /** How far below the panel's own top the message may sit: enough for its
      heading row alone (creators, traders), or for the screener's taller,
      several-row toolbar (view tabs, filter, window tabs) above the table
      at 390px - still "at the top", never below a screen of reserved rows. */
  maxHeadingOffset: number;
  /** The failed list keeps the height it reserved while pending. */
  keepsGeometry: boolean;
};

const cases: ListCase[] = [
  {
    name: "creators",
    url: "/creators/",
    apiPattern: "**/api/product/creators**",
    subject: "Creators",
    rows: (page) =>
      page
        .locator(".desktop-creators tbody tr, .mobile-creator")
        .filter({ visible: true }),
    panel: (page) => page.locator(".creators-panel"),
    maxHeadingOffset: 200,
    keepsGeometry: true,
  },
  {
    name: "traders",
    url: "/traders/",
    apiPattern: "**/api/product/leaderboard**",
    subject: "Leaderboard",
    rows: (page) =>
      page
        .locator(".desktop-traders tbody tr, .mobile-trader")
        .filter({ visible: true }),
    panel: (page) => page.locator(".leaderboard-panel"),
    maxHeadingOffset: 200,
    keepsGeometry: false,
  },
  {
    name: "screener",
    url: "/",
    apiPattern: "**/api/product/explore**",
    subject: "Pools",
    rows: (page) =>
      page
        .locator(".desktop-pools tbody tr, .mobile-pool")
        .filter({ visible: true }),
    panel: (page) => page.locator(".explore-page .panel").first(),
    maxHeadingOffset: 350,
    keepsGeometry: true,
  },
];

for (const c of cases) {
  test(`${c.name}: pending rows reserve, a failed first read ${c.keepsGeometry ? "keeps their geometry" : "collapses them"} and the retry control sits at the top`, async ({
    page,
  }, testInfo) => {
    // The screener's own list read shares its endpoint with the launch
    // rail's, so every request matching this pattern - not just the first -
    // must be held, then failed, then finally let through, together.
    let calls = 0;
    let mode: "hold" | "fail" | "pass" = "hold";
    let releaseHeld = () => {};
    const held = new Promise<void>((resolve) => {
      releaseHeld = resolve;
    });
    await page.route(c.apiPattern, async (route) => {
      calls++;
      if (mode === "hold") await held;
      if (mode === "pass") {
        await route.fallback();
        return;
      }
      await route.fulfill({ status: 503, json: { error: "data_unavailable" } });
    });

    await page.goto(c.url);

    // Pending: the list reserves its rows (skeleton content) rather than
    // showing nothing while the first read is still on the wire.
    await expect(c.rows(page).first()).toBeVisible();
    const pendingCount = await c.rows(page).count();
    expect(
      pendingCount,
      "a pending list reserves its target row count",
    ).toBeGreaterThan(10);
    await expect(
      page.getByRole("heading", { name: `${c.subject} unavailable` }),
    ).toHaveCount(0);
    const pendingPanel = (await c.panel(page).boundingBox())!;

    // Fail the first read: no reserved row stays on show, and the compact
    // UnavailableState with its retry control sits in their place.
    mode = "fail";
    releaseHeld();
    const heading = page.getByRole("heading", {
      name: `${c.subject} unavailable`,
    });
    await expect(heading).toBeVisible();
    await expect(c.rows(page)).toHaveCount(0);
    const retry = page.getByRole("button", { name: "Try again" });
    await expect(retry).toBeVisible();

    const panelBox = (await c.panel(page).boundingBox())!;
    const messageBox = (await heading.boundingBox())!;
    expect(
      messageBox.y - panelBox.y,
      "the retry control sits at the top of the list area, not below a screen of blank rows",
    ).toBeLessThan(c.maxHeadingOffset);
    if (c.keepsGeometry)
      expect(
        panelBox,
        "the failed list keeps the geometry it reserved, so nothing under it moves",
      ).toEqual(pendingPanel);

    // 390px still reads as a compact panel, not a page stretched by a
    // reservation nothing shows any more.
    if (testInfo.project.name === "mobile") {
      const pageHeight = await page.evaluate(
        () => document.documentElement.scrollHeight,
      );
      expect(
        pageHeight,
        "the failed panel does not leave thousands of px of dead reserved space",
      ).toBeLessThan(4000);
    }

    // The retry control actually retries: a successful second read replaces
    // the unavailable state with real rows, at the same shared geometry.
    mode = "pass";
    await retry.click();
    await expect(heading).toHaveCount(0);
    await expect(c.rows(page).first()).toBeVisible();
    expect(calls).toBeGreaterThan(1);
  });
}

test("wallet: a failed first read reports unavailable immediately, with no positions reservation left showing", async ({
  page,
}) => {
  // Reassigning a resolver inside the route handler itself races page.goto():
  // goto() can resolve before the client's own wallet fetch ever reaches
  // this interceptor, so releasing "the" held promise before that request
  // arrives is a no-op, and the request that arrives afterwards is held on
  // a promise nothing ever resolves again - the page then sits in its
  // pending state forever instead of reaching "Wallet unavailable". A single
  // promise created up front, and a `mode` flag read fresh on every
  // invocation, has no such ordering dependency (matching the loop-based
  // cases above).
  let calls = 0;
  let mode: "hold" | "fail" | "pass" = "hold";
  let releaseHeld = () => {};
  const held = new Promise<void>((resolve) => {
    releaseHeld = resolve;
  });
  await page.route(`**/api/product/wallets/${wallet}/**`, async (route) => {
    calls++;
    if (mode === "hold") await held;
    if (mode === "pass") {
      await route.fallback();
      return;
    }
    await route.fulfill({ status: 503, json: { error: "data_unavailable" } });
  });

  await page.goto(`/wallet/${wallet}/?window=All`);
  const heading = page.getByRole("heading", { name: "Wallet unavailable" });
  await expect(heading).toHaveCount(0);
  mode = "fail";
  releaseHeld();
  await expect(heading).toBeVisible();
  const retry = page.getByRole("button", { name: "Try again" });
  await expect(retry).toBeVisible();
  // Nothing from the positions tab renders behind the failed state: no
  // reserved rows are left showing (or taking up space) beneath it.
  await expect(page.locator(".wallet-positions-table")).toHaveCount(0);
  await expect(page.locator(".mobile-position")).toHaveCount(0);

  mode = "pass";
  await retry.click();
  await expect(heading).toHaveCount(0);
  await expect(
    page
      .locator(".wallet-activity [data-row='resolved']")
      .filter({ visible: true })
      .first(),
  ).toBeVisible();
  expect(calls).toBeGreaterThan(1);
});
