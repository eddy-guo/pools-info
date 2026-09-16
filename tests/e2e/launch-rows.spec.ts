import { test, expect } from "@playwright/test";

/* The screener opens on measured pools; a pool with no market evidence reads
   as its launch facts instead of a row of unavailable marks. Both viewports
   are checked because the table and the mobile cards render separately. */

const ROWS = ".explore-page [data-row='resolved']";

const rows = (page: import("@playwright/test").Page) =>
  page.locator(ROWS).filter({ visible: true });

test("the default screener leads with pools that have prices", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  await expect(rows(page).first()).toBeVisible();
  await expect(page).not.toHaveURL(/sort=/);
  const counts = await page.evaluate(() => {
    const shown = (node: Element) => !!node.getClientRects().length;
    const list = [
      ...document.querySelectorAll(".explore-page [data-row='resolved']"),
    ].filter(shown);
    return {
      resolved: list.length,
      priced: list.filter(
        (row) =>
          !!row.querySelector(".price") &&
          !row.querySelector(".price")!.classList.contains("unavailable"),
      ).length,
      launchRows: list.filter(
        (row) => !!row.querySelector(".launch-cell, [data-launch-row]"),
      ).length,
      reservedMarks: [
        ...document.querySelectorAll(
          ".explore-page [data-row='reserved'] .unavailable",
        ),
      ].filter(shown).length,
    };
  });
  await testInfo.attach("default-rows", {
    body: JSON.stringify(counts),
    contentType: "application/json",
  });
  expect(counts.resolved, "the first page has rows").toBeGreaterThan(0);
  expect(counts.priced, "every row on page one has an observed price").toBe(
    counts.resolved,
  );
  expect(counts.launchRows, "no launch-only rows in the volume sort").toBe(0);
  expect(
    counts.reservedMarks,
    "a row held open for the page height carries no N/A",
  ).toBe(0);
  await expect(page.locator("main")).not.toContainText("Market evidence");
});

test("the launches tab reads as launches, not as unavailable cells", async ({
  page,
}, testInfo) => {
  await page.goto("/?view=new");
  await expect(rows(page).first()).toBeVisible();
  const measured = await page.evaluate(() => {
    const shown = (node: Element) => !!node.getClientRects().length;
    const list = [
      ...document.querySelectorAll(".explore-page [data-row='resolved']"),
    ].filter(shown);
    return {
      resolved: list.length,
      withLaunchRow: list.filter(
        (row) => !!row.querySelector(".launch-cell, [data-launch-row]"),
      ).length,
      /* The live trade rail is a separate feed this suite does not serve,
         so its stamp reads N/A; the launches page is the rows and the rail. */
      unavailable: [
        ...document.querySelectorAll(
          ".explore-page :is(.desktop-pools, .mobile-pools, .launch-rail) .unavailable",
        ),
      ].filter(shown).length,
      firstLine: list[0]?.querySelector(".launch-line")?.textContent ?? null,
      firstFacts: [
        ...(list[0]?.querySelectorAll("[data-launch-row] strong") ?? []),
      ].map((node) => node.textContent),
      rowHeights: [
        ...new Set(
          list.map((row) => Math.round(row.getBoundingClientRect().height)),
        ),
      ],
    };
  });
  await testInfo.attach("launch-rows", {
    body: JSON.stringify(measured),
    contentType: "application/json",
  });
  expect(measured.resolved, "the launches tab has rows").toBeGreaterThan(0);
  expect(measured.withLaunchRow, "every row reads as a launch").toBe(
    measured.resolved,
  );
  expect(measured.unavailable, "no unavailable marks on a launches page").toBe(
    0,
  );
  expect(measured.rowHeights, "rows keep one height").toHaveLength(1);
  if (testInfo.project.name === "desktop") {
    expect(measured.firstLine, "age and sender").toMatch(
      /^Launched .+ ago · 0x[0-9a-f]{4}…[0-9a-f]{4}$/,
    );
    await expect(
      page.locator(".pool-table thead th"),
      "the metric headers a launches page cannot fill are gone",
    ).toHaveCount(3);
    await expect(page.locator(".pool-table thead")).not.toContainText(
      "Liquidity",
    );
  } else {
    /* The mobile card holds a fixed height, so the same two facts take
       the stat slots the measured card uses. */
    expect(measured.firstFacts, "age and sender").toEqual([
      expect.stringMatching(/^(<1m|\d+[mhd]) ago$/),
      expect.stringMatching(/^0x[0-9a-f]{4}…[0-9a-f]{4}$/),
    ]);
  }
  await expect(
    page.locator(".launch-cell a, [data-launch-row] a").first(),
    "the sender opens its wallet",
  ).toHaveAttribute("href", /^\/wallet\/0x[0-9a-f]{40}\/$/);
  if (testInfo.project.name !== "desktop")
    expect(
      await page
        .locator("[data-launch-row] a")
        .first()
        .evaluate((node) => node.getBoundingClientRect().height),
      "44px tap target",
    ).toBeGreaterThanOrEqual(44);
});

test("a launch rail card shows its age and sender, never two N/A marks", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  await expect(
    page.locator(".launch-rail .launch-card strong").first(),
  ).not.toHaveText("Pool pending");
  const rail = await page.evaluate(() => {
    const list = [...document.querySelectorAll(".launch-rail .launch-card")];
    return list.map((card) => ({
      priced: !!card.querySelector(".price:not(.unavailable)"),
      age: card.querySelector(".launch-card-identity time")?.textContent ?? "",
      sender: card.querySelector(".launch-card-sender")?.textContent ?? "",
      unavailable: card.querySelectorAll(".unavailable").length,
      height: Math.round(card.getBoundingClientRect().height),
    }));
  });
  await testInfo.attach("launch-rail", {
    body: JSON.stringify(rail),
    contentType: "application/json",
  });
  for (const card of rail.filter((c) => !c.priced)) {
    expect(card.age, "the card carries its launch age").toMatch(
      /^(<1m|\d+[mhd])$/,
    );
    expect(card.sender, "the card carries its launch sender").toMatch(
      /^0x[0-9a-f]{4}…[0-9a-f]{4}$/,
    );
    expect(card.unavailable, "no N/A on a launch card").toBe(0);
  }
  expect(
    [...new Set(rail.map((card) => card.height))],
    "every card keeps one height",
  ).toHaveLength(1);
});
