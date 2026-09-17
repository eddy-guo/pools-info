import { test, expect, type Page, type TestInfo } from "@playwright/test";

/* The screener windows its rows against the document scroll: only the rows
   near the viewport are in the DOM, each 25-row page is read as the viewport
   approaches it, and the position survives a trip to a pool and back. The
   launch order is the list with more than one page in the saved dataset. */

const LIST = "/?sort=launch&window=All";
const PAGE_ROWS = 25;
const PREFETCH = 10;

type Layout = ReturnType<typeof layout>;
function layout(testInfo: TestInfo) {
  return testInfo.project.name === "desktop"
    ? {
        wrapper: ".explore-page .desktop-pools",
        list: ".explore-page .desktop-pools tbody",
        rows: ".explore-page .desktop-pools tbody tr[data-row]",
        rowHeight: 62,
      }
    : {
        wrapper: ".explore-page .mobile-pools",
        list: ".explore-page .mobile-pools",
        rows: ".explore-page .mobile-pools .mobile-pool",
        rowHeight: 168,
      };
}
/** Explore page requests: the 25-row reads, not the launch rail's six. */
const pageRequest = (url: string) => {
  const params = new URL(url).searchParams;
  return url.includes("/api/product/explore") && params.get("limit") === "25"
    ? Number(params.get("offset"))
    : null;
};
const listTop = (page: Page, list: string) =>
  page.evaluate(
    (selector) =>
      document.querySelector(selector)!.getBoundingClientRect().top +
      window.scrollY,
    list,
  );
/** Scrolls so the viewport's bottom edge sits `rows` rows below the list's top. */
async function scrollBottomToRow(
  page: Page,
  { list, rowHeight }: Layout,
  rows: number,
) {
  const top = await listTop(page, list);
  await page.evaluate(
    ({ top, rows, rowHeight }) =>
      window.scrollTo({
        top: top + rows * rowHeight - window.innerHeight,
        behavior: "instant",
      }),
    { top, rows, rowHeight },
  );
}
const resolvedRows = (page: Page, rows: string) =>
  page.locator(`${rows}[data-row='resolved']`);

test("only the rows near the viewport are in the DOM, and the next page reads as the viewport approaches it", async ({
  page,
  request,
}, testInfo) => {
  const shown = layout(testInfo),
    { list, rows, rowHeight } = shown;
  const { total } = await (
    await request.get(
      "/api/product/explore/?window=All&sort=launch&direction=desc&limit=1",
    )
  ).json();
  expect(total, "the launch order spans more than one page").toBeGreaterThan(
    PAGE_ROWS,
  );
  const offsets: number[] = [];
  let release = () => {};
  await page.route("**/api/product/explore/?**", async (route) => {
    const offset = pageRequest(route.request().url());
    if (offset === null) return route.continue();
    offsets.push(offset);
    // The second page waits, so the rows on screen can be read mid-flight.
    if (offset === PAGE_ROWS)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    await route.continue().catch(() => {
      /* A superseded request is aborted by the page; nothing to answer. */
    });
  });
  await page.goto(LIST);
  await expect(resolvedRows(page, rows).first()).toBeVisible();
  expect(offsets, "the first page alone loads with the route").toEqual([0]);

  const geometry = await page.evaluate(
    ({ list, rows, rowHeight }) => {
      const node = document.querySelector(list)!;
      const rendered = [...document.querySelectorAll(rows)];
      return {
        height: node.getBoundingClientRect().height,
        rendered: rendered.length,
        heights: [
          ...new Set(
            rendered.map((row) =>
              Math.round(row.getBoundingClientRect().height),
            ),
          ),
        ],
        spacers: [
          ...node.querySelectorAll(":scope > .spacer, :scope > tr.spacer"),
        ].length,
        rowHeight,
      };
    },
    { list, rows, rowHeight },
  );
  await testInfo.attach("window-geometry", {
    body: JSON.stringify(geometry),
    contentType: "application/json",
  });
  expect(geometry.height, "the list holds every row's height").toBe(
    total * rowHeight,
  );
  expect(geometry.heights, "rows keep the one fixed height").toEqual([
    rowHeight,
  ]);
  expect(geometry.rendered, "the DOM holds a viewport of rows").toBeLessThan(
    41,
  );
  expect(geometry.spacers, "one spacer holds the rows below").toBe(1);

  /* Ten rows short of the loaded end, the next page is not asked for. */
  await scrollBottomToRow(page, shown, PAGE_ROWS - PREFETCH - 0.5);
  await page.waitForTimeout(300);
  expect(offsets).toEqual([0]);
  /* Within ten rows of it, the page is read while every row stays put. */
  await scrollBottomToRow(page, shown, PAGE_ROWS - PREFETCH + 1.5);
  await expect.poll(() => offsets).toEqual([0, PAGE_ROWS]);
  const resolved = resolvedRows(page, rows);
  const before = await resolved.count();
  expect(before).toBeGreaterThan(0);
  await expect(
    page.locator(`${list} [data-pending="true"]`),
    "no shimmer while a page appends",
  ).toHaveCount(0);
  await expect(page.locator("[data-stale-rows='true']")).toHaveCount(0);
  release();
  /* The held page still has its read API round trip ahead of it. */
  await expect
    .poll(
      () =>
        page
          .locator(`${rows}[data-index='${PAGE_ROWS}'][data-row='resolved']`)
          .count(),
      { timeout: 15000 },
    )
    .toBe(1);
  expect(await resolved.count()).toBeGreaterThanOrEqual(before);
  await expect(page.locator("[data-stale-rows='true']")).toHaveCount(0);
});

test("the page controls are gone and the URL keeps sort, dir, view and q without offset", async ({
  page,
}) => {
  await page.goto("/?view=gainers&sort=trades&dir=asc&q=a&offset=25");
  await expect(page.locator(".explore-page .workspace-grid")).toBeVisible();
  await expect(page).not.toHaveURL(/offset=/);
  const params = new URL(page.url()).searchParams;
  expect(Object.fromEntries(params)).toEqual({
    view: "gainers",
    sort: "trades",
    dir: "asc",
    q: "a",
  });
  const explore = page.locator(".explore-page");
  await expect(explore.locator(".pagination")).toHaveCount(0);
  await expect(explore.getByRole("button", { name: "Previous" })).toHaveCount(
    0,
  );
  await expect(explore.getByRole("button", { name: "Next" })).toHaveCount(0);
});

test("a sort change brings the list back to the top and dims the rows until the first page arrives", async ({
  page,
}, testInfo) => {
  const shown = layout(testInfo),
    { wrapper, list, rows } = shown;
  let release = () => {},
    gated = false;
  await page.route("**/api/product/explore/?**", async (route) => {
    const params = new URL(route.request().url()).searchParams;
    if (
      pageRequest(route.request().url()) === null ||
      (params.get("sort") === "launch" && params.get("view") === "all")
    )
      return route.continue();
    gated = true;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await route.continue();
  });
  await page.goto(LIST);
  await expect(resolvedRows(page, rows).first()).toBeVisible();
  const first = await resolvedRows(page, rows)
    .first()
    .locator("strong")
    .first()
    .textContent();
  /* A keyboard reader focuses a view tab in the panel's head, scrolls away
     to look at rows, then presses Enter. */
  const control = page
    .locator(".explore-toolbar .table-tabs")
    .getByRole("button", { name: "Gainers" });
  await control.focus();
  await scrollBottomToRow(page, shown, 40);
  await expect
    .poll(() =>
      page.locator(`${rows}[data-index='30'][data-row='resolved']`).count(),
    )
    .toBe(1);
  const panel = page.locator(".explore-page .panel").first();
  expect(
    (await panel.boundingBox())!.y,
    "the panel head has scrolled away",
  ).toBeLessThan(0);
  await expect(control).toBeFocused();
  await page.keyboard.press("Enter");
  await expect.poll(() => gated).toBe(true);
  const busy = page.locator(wrapper);
  await expect(busy).toHaveAttribute("data-stale-rows", "true");
  await expect(busy).toHaveAttribute("aria-busy", "true");
  await expect(
    page.locator(`${rows}[data-row='resolved']`).first(),
    "the previous rows stay while the new order loads",
  ).toBeVisible();
  await expect(page.locator(`${list} [data-pending="true"]`)).toHaveCount(0);
  const padding = await page.evaluate(() =>
    parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop),
  );
  await expect
    .poll(async () => Math.round((await panel.boundingBox())!.y), {
      message: "the panel head returns under the site header",
    })
    .toBe(Math.round(padding));
  release();
  /* The held page still has its read API round trip ahead of it. */
  await expect(busy).toHaveAttribute("data-stale-rows", "false", {
    timeout: 15000,
  });
  await expect(busy).toHaveAttribute("aria-busy", "false");
  await expect(resolvedRows(page, rows).first()).toBeVisible();
  expect(
    await resolvedRows(page, rows)
      .first()
      .locator("strong")
      .first()
      .textContent(),
    "the new order leads with a different pool",
  ).not.toBe(first);
  expect(new URL(page.url()).searchParams.get("view")).toBe("gainers");
});

test("Back within the session lands on the same rows and reads their page first", async ({
  page,
}, testInfo) => {
  const shown = layout(testInfo),
    { rows } = shown;
  await page.goto(LIST);
  await expect(resolvedRows(page, rows).first()).toBeVisible();
  /* Row 50 sits in the viewport with the first page more than ten rows above. */
  await scrollBottomToRow(page, shown, 60);
  const target = page.locator(`${rows}[data-index='50']`);
  await expect(target).toHaveAttribute("data-row", "resolved");
  const name = await target.locator("strong").first().textContent();
  const link = target.locator("a.token-cell");
  await link.scrollIntoViewIfNeeded();
  const scrolled = await page.evaluate(() => window.scrollY);
  const offsets: number[] = [];
  page.on("request", (request) => {
    const offset = pageRequest(request.url());
    if (offset !== null) offsets.push(offset);
  });
  await link.click();
  await expect(page).toHaveURL(/\/pool\//);
  offsets.length = 0;
  await page.goBack();
  await expect(page).toHaveURL(/sort=launch/);
  await expect(page.locator(`${rows}[data-index='50']`)).toHaveAttribute(
    "data-row",
    "resolved",
    { timeout: 15000 },
  );
  expect(await page.evaluate(() => window.scrollY), "the scroll position").toBe(
    scrolled,
  );
  await expect(
    page.locator(`${rows}[data-index='50']`).locator("strong").first(),
  ).toHaveText(name!);
  /* The rows read ahead reach ten rows above the viewport, into the second
     page; the first page is not among them. */
  expect(offsets[0], "the page on screen is read before the first").toBe(
    PAGE_ROWS,
  );
});

test("keyboard focus walks the rows in order past the first window", async ({
  page,
}, testInfo) => {
  const { rows } = layout(testInfo);
  await page.goto(LIST);
  await expect(resolvedRows(page, rows).first()).toBeVisible();
  const initial = await page.locator(rows).count();
  await resolvedRows(page, rows).first().locator("a.token-cell").focus();
  const visited: number[] = [];
  for (let i = 0; i < 90; i++) {
    await page.keyboard.press("Tab");
    const index = await page.evaluate(() => {
      const row = document.activeElement?.closest("[data-index]");
      return row ? Number((row as HTMLElement).dataset.index) : null;
    });
    if (index === null) break;
    visited.push(index);
    /* Focus scrolls smoothly; the next step waits for the scroll to settle,
       the way a reader's next keypress follows what they see. */
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          let last = window.scrollY;
          const settled = () => {
            if (window.scrollY === last) return resolve();
            last = window.scrollY;
            setTimeout(settled, 50);
          };
          setTimeout(settled, 50);
        }),
    );
  }
  await testInfo.attach("focus-order", {
    body: JSON.stringify({ initial, visited }),
    contentType: "application/json",
  });
  expect(visited.length, "focus stays in the rows").toBe(90);
  for (let i = 1; i < visited.length; i++)
    expect(visited[i], `step ${i}`).toBeGreaterThanOrEqual(visited[i - 1]);
  expect(
    visited[visited.length - 1],
    "focus reaches rows the first window did not hold",
  ).toBeGreaterThanOrEqual(initial);
});

test("scrolling through the list records no long task and no layout shift", async ({
  page,
}, testInfo) => {
  const { list, rows } = layout(testInfo);
  await page.addInitScript(() => {
    const state = {
      longTasks: [] as number[],
      shifts: 0,
      sources: [] as unknown[],
    };
    Object.assign(window, { scrollMeasurement: state });
    new PerformanceObserver((entries) => {
      for (const entry of entries.getEntries())
        state.longTasks.push(Math.round(entry.duration));
    }).observe({ type: "longtask", buffered: true });
    new PerformanceObserver((entries) => {
      for (const raw of entries.getEntries()) {
        const shift = raw as PerformanceEntry & {
          hadRecentInput: boolean;
          value: number;
          sources?: {
            node: Element | null;
            previousRect: DOMRectReadOnly;
            currentRect: DOMRectReadOnly;
          }[];
        };
        if (shift.hadRecentInput) continue;
        state.shifts += shift.value;
        state.sources.push({
          value: shift.value,
          at: Math.round(shift.startTime),
          nodes: (shift.sources ?? []).map((source) => ({
            node: source.node
              ? `${source.node.tagName}.${source.node.className}`
              : null,
            from: source.previousRect.toJSON(),
            to: source.currentRect.toJSON(),
          })),
        });
      }
    }).observe({ type: "layout-shift", buffered: true });
  });
  await page.goto(LIST);
  await expect(resolvedRows(page, rows).first()).toBeVisible();
  await page.waitForLoadState("networkidle");
  /* One call holds a whole walk, so nothing but the page runs between the
     counters' reset and their reading: twenty screens or the list's end, a
     dozen frames on each, then a pause for the last pages. A shared machine
     can hand the page one stray long task, so a walk that records one is
     walked once more; a page that stalls on its own stalls both times. */
  const walk = () =>
    page.evaluate(async (list) => {
      const state = (
        window as unknown as {
          scrollMeasurement: {
            longTasks: number[];
            shifts: number;
            sources: unknown[];
          };
        }
      ).scrollMeasurement;
      window.scrollTo({ top: 0, behavior: "instant" });
      await new Promise((resolve) => setTimeout(resolve, 300));
      state.longTasks.length = 0;
      state.shifts = 0;
      state.sources.length = 0;
      const top =
        document.querySelector(list)!.getBoundingClientRect().top +
        window.scrollY;
      const frame = () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      let screens = 0;
      for (; screens < 20; screens++) {
        const next = top + screens * window.innerHeight;
        if (next > document.documentElement.scrollHeight - window.innerHeight)
          break;
        window.scrollTo({ top: next, behavior: "instant" });
        for (let i = 0; i < 12; i++) await frame();
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return { screens, ...state };
    }, list);
  const walks = [await walk()];
  if (walks[0].longTasks.length) walks.push(await walk());
  const measurement = walks[walks.length - 1];
  const rendered = await page.locator(rows).count();
  console.log(
    JSON.stringify({
      viewport: testInfo.project.name,
      rendered,
      walks,
    }),
  );
  await testInfo.attach("scroll-measurement", {
    body: JSON.stringify({ rendered, walks }),
    contentType: "application/json",
  });
  expect(rendered, "the DOM still holds a viewport of rows").toBeLessThan(41);
  expect(measurement.longTasks, "no task over 50ms while scrolling").toEqual(
    [],
  );
  for (const { shifts } of walks)
    expect(shifts, "no layout shift while scrolling").toBe(0);
});
