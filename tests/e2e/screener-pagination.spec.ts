import { test, expect, type Page, type TestInfo } from "@playwright/test";

/* The screener shows 25 rows and one "Show 25 more" under them: each click
   appends the next 25 in place and lands focus on the first new row, the
   count on show lives in the URL as `limit`, so a reload or Back brings the
   same rows back, and the control goes once every row is on show. The launch
   order is the list with more than one page in the saved dataset. */

const LIST = "/?sort=launch&window=All";
const PAGE = 25;

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
/** Explore page reads: the list's, not the launch rail's six. */
const listRead = (url: string) => {
  const params = new URL(url).searchParams;
  return url.includes("/api/product/explore") && params.get("limit") !== "6"
    ? {
        offset: Number(params.get("offset")),
        limit: Number(params.get("limit")),
      }
    : null;
};
const foot = (page: Page) => page.locator(".explore-page .pagination");
/** The one control under the list; its label names the rows left when fewer than a page remain. */
const more = (page: Page) =>
  foot(page).getByRole("button", { name: /^Show \d+ more$/ });
const count = (page: Page) => foot(page).locator(".pagination-count");
const resolvedRows = (page: Page, rows: string) =>
  page.locator(`${rows}[data-row='resolved']`);
const rowName = (page: Page, rows: string, index: number) =>
  page.locator(`${rows}[data-row-index='${index}']`).locator("strong").first();
/** Scrolls so the viewport's bottom edge sits `rows` rows below the list's top. */
async function scrollBottomToRow(
  page: Page,
  { list, rowHeight }: Layout,
  rows: number,
) {
  await page.evaluate(
    ({ list, rows, rowHeight }) => {
      const top =
        document.querySelector(list)!.getBoundingClientRect().top +
        window.scrollY;
      window.scrollTo({
        top: top + rows * rowHeight - window.innerHeight,
        behavior: "instant",
      });
    },
    { list, rows, rowHeight },
  );
}
async function trackShifts(page: Page) {
  await page.addInitScript(() => {
    const state = { cls: 0, sources: [] as unknown[] };
    Object.assign(window, { shiftMeasurement: state });
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
        state.cls += shift.value;
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
}
const shifts = (page: Page) =>
  page.evaluate(
    () =>
      (
        window as unknown as {
          shiftMeasurement: { cls: number; sources: unknown[] };
        }
      ).shiftMeasurement,
  );
const focusedRow = (page: Page) =>
  page.evaluate(() => {
    const row = document.activeElement?.closest("[data-row-index]");
    return row ? Number((row as HTMLElement).dataset.rowIndex) : null;
  });

test("Show 25 more appends each page in place, keeps the count in the URL, lands focus on the first new row and goes at the end", async ({
  page,
  request,
}, testInfo) => {
  const shown = layout(testInfo),
    { rows } = shown;
  const { total } = await (
    await request.get(
      "/api/product/explore/?window=All&sort=launch&direction=desc&limit=1",
    )
  ).json();
  expect(total, "the launch order spans more than two pages").toBeGreaterThan(
    2 * PAGE,
  );
  await trackShifts(page);
  const reads: { offset: number; limit: number }[] = [];
  let release = () => {};
  await page.route("**/api/product/explore/?**", async (route) => {
    const read = listRead(route.request().url());
    if (read === null) return route.continue();
    reads.push(read);
    /* The first append waits past the input window, so the rows it lands
       are measured for shift like any other response. */
    if (read.offset === PAGE)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    await route.continue().catch(() => {
      /* A superseded request is aborted by the page; nothing to answer. */
    });
  });
  await page.goto(LIST);
  await expect(resolvedRows(page, rows)).toHaveCount(PAGE);
  await expect(page.locator(rows)).toHaveCount(PAGE);
  await expect(count(page)).toHaveText(`Showing ${PAGE} of ${total}`);
  await expect(page).not.toHaveURL(/limit=/);
  await expect(more(page)).toBeEnabled();
  expect(reads, "one read of the first page").toEqual([
    { offset: 0, limit: PAGE },
  ]);
  const first = await rowName(page, rows, 0).textContent();

  /* The control sits under the list; the reader scrolls to it and clicks. */
  await more(page).scrollIntoViewIfNeeded();
  const scrolled = await page.evaluate(() => window.scrollY);
  await more(page).click();
  await expect(page).toHaveURL(/[?&]limit=50(?:&|$)/);
  await expect(page.locator(rows)).toHaveCount(2 * PAGE);
  await expect(resolvedRows(page, rows)).toHaveCount(PAGE);
  await expect(
    page.locator(`${rows}[data-row='skeleton']`),
    "the next page's rows shimmer in place under the ones on show",
  ).toHaveCount(PAGE);
  await expect(page.locator(shown.wrapper)).toHaveAttribute(
    "aria-busy",
    "true",
  );
  await expect(more(page)).toBeDisabled();
  await expect.poll(() => reads.length).toBe(2);
  expect(reads[1], "the next page is read from where the rows end").toEqual({
    offset: PAGE,
    limit: PAGE,
  });
  expect(
    await page.evaluate(() => window.scrollY),
    "the reader stays where they clicked",
  ).toBeGreaterThanOrEqual(scrolled);
  await page.waitForTimeout(600);
  release();
  await expect(resolvedRows(page, rows)).toHaveCount(2 * PAGE);
  await expect(page.locator(`${rows}[data-row='skeleton']`)).toHaveCount(0);
  await expect(page.locator(shown.wrapper)).toHaveAttribute(
    "aria-busy",
    "false",
  );
  await expect(count(page)).toHaveText(`Showing ${2 * PAGE} of ${total}`);
  await expect(rowName(page, rows, 0)).toHaveText(first!);
  await expect
    .poll(() => focusedRow(page), {
      message: "focus lands on the first new row",
    })
    .toBe(PAGE);

  /* Every further click adds a page until the list ends, and the last
     asks for exactly the rows left. */
  let onShow = 2 * PAGE;
  while (onShow < total) {
    await more(page).click();
    onShow = Math.min(onShow + PAGE, total);
    await expect(page).toHaveURL(new RegExp(`[?&]limit=${onShow}(?:&|$)`));
    await expect(page.locator(rows)).toHaveCount(onShow);
    await expect(resolvedRows(page, rows)).toHaveCount(onShow);
    await expect(count(page)).toHaveText(`Showing ${onShow} of ${total}`);
  }
  await expect(
    page.locator(`${rows}[data-row='reserved']`),
    "no blank rows past the list's end",
  ).toHaveCount(0);
  await expect(
    more(page),
    "the control goes once every row is on show",
  ).toBeHidden();
  const measurement = await shifts(page);
  await testInfo.attach("shift-measurement", {
    body: JSON.stringify({ reads, ...measurement }),
    contentType: "application/json",
  });
  expect(measurement.cls, "no layout shift while pages append").toBe(0);
});

test("a reload and Back bring back the rows on show", async ({
  page,
}, testInfo) => {
  const { rows } = layout(testInfo);
  await page.goto(LIST);
  await expect(resolvedRows(page, rows)).toHaveCount(PAGE);
  await more(page).click();
  await expect(resolvedRows(page, rows)).toHaveCount(2 * PAGE);
  const name = await rowName(page, rows, PAGE + 5).textContent();
  const reads: { offset: number; limit: number }[] = [];
  page.on("request", (request) => {
    const read = listRead(request.url());
    if (read !== null) reads.push(read);
  });
  await page.reload();
  await expect(page).toHaveURL(/[?&]limit=50(?:&|$)/);
  await expect(page.locator(rows)).toHaveCount(2 * PAGE);
  await expect(resolvedRows(page, rows)).toHaveCount(2 * PAGE);
  await expect(rowName(page, rows, PAGE + 5)).toHaveText(name!);
  expect(reads, "the rows on show come back in one read").toEqual([
    { offset: 0, limit: 2 * PAGE },
  ]);
  const link = page
    .locator(`${rows}[data-row-index='${PAGE + 5}']`)
    .locator("a.token-cell");
  await link.click();
  await expect(page).toHaveURL(/\/pool\//);
  await page.goBack();
  await expect(page).toHaveURL(/[?&]limit=50(?:&|$)/);
  await expect(resolvedRows(page, rows)).toHaveCount(2 * PAGE);
  await expect(rowName(page, rows, PAGE + 5)).toHaveText(name!);
});

test("a view change starts over at the first page, brings the head back and swaps to skeleton rows", async ({
  page,
}, testInfo) => {
  const shown = layout(testInfo),
    { wrapper, list, rows } = shown;
  let release = () => {},
    gated = false;
  await page.route("**/api/product/explore/?**", async (route) => {
    const params = new URL(route.request().url()).searchParams;
    if (
      listRead(route.request().url()) === null ||
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
  await expect(resolvedRows(page, rows)).toHaveCount(PAGE);
  await more(page).click();
  await expect(resolvedRows(page, rows)).toHaveCount(2 * PAGE);
  const first = await rowName(page, rows, 0).textContent();
  /* A keyboard reader focuses a view tab in the panel's head, scrolls away
     to look at rows, then presses Enter. */
  const control = page
    .locator(".explore-toolbar .table-tabs")
    .getByRole("button", { name: "Gainers" });
  await control.focus();
  await scrollBottomToRow(page, shown, 40);
  const panel = page.locator(".explore-page .panel").first();
  expect(
    (await panel.boundingBox())!.y,
    "the panel head has scrolled away",
  ).toBeLessThan(0);
  await expect(control).toBeFocused();
  await page.keyboard.press("Enter");
  await expect.poll(() => gated).toBe(true);
  const busy = page.locator(wrapper);
  await expect(busy).not.toHaveAttribute("data-stale-rows", /.*/);
  await expect(busy).toHaveAttribute("aria-busy", "true");
  /* No dim-then-redraw: the previous view's rows are gone the instant the
     new one is requested, replaced in the same frame by one page of skeleton
     rows of the same row height and column layout, with the classic shimmer. */
  await expect(page).not.toHaveURL(/limit=/);
  await expect(page.locator(rows)).toHaveCount(PAGE);
  await expect(
    resolvedRows(page, rows),
    "the previous rows are gone, not dimmed in place",
  ).toHaveCount(0);
  await expect(page.locator(`${rows}[data-row='skeleton']`)).toHaveCount(PAGE);
  await expect(
    page.locator(`${list} [data-pending="true"]`).first(),
  ).toBeVisible();
  const padding = await page.evaluate(() =>
    parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop),
  );
  await expect
    .poll(async () => Math.round((await panel.boundingBox())!.y), {
      message: "the panel head returns under the site header",
    })
    .toBe(Math.round(padding));
  release();
  await expect(busy).toHaveAttribute("aria-busy", "false", { timeout: 15000 });
  await expect(page.locator(`${rows}[data-row='skeleton']`)).toHaveCount(0);
  await expect(resolvedRows(page, rows).first()).toBeVisible();
  expect(
    await rowName(page, rows, 0).textContent(),
    "the new view leads with a different pool",
  ).not.toBe(first);
  expect(new URL(page.url()).searchParams.get("view")).toBe("gainers");
});
