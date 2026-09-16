import { test, expect, type Page } from "@playwright/test";

const px = (value: string) => Number.parseFloat(value);
/* The read API orders by these; every other column stays a plain header. */
const sortable = [
  { label: "Change", key: "change", column: 4 },
  { label: "Volume", key: "volume", column: 5 },
  { label: "Trades", key: "trades", column: 6 },
  { label: "Liquidity", key: "liquidity", column: 7 },
];
const plain = ["Token", "Price", "Holders", "Launch sender", "Trend"];
/* With no sort in the URL the screener reads by volume, highest first. */
const defaultColumn = 5;

const head = (page: Page) => page.locator(".explore-page .desktop-pools thead");
const header = (page: Page, column: number) =>
  head(page).locator(`th:nth-child(${column})`);
const search = (page: Page) => new URL(page.url()).searchParams;
/* Waiting on the request proves the order reached the API, not just the URL. */
const exploreRequest = (page: Page) =>
  page.waitForRequest(
    (request) =>
      request.url().includes("/api/product/explore") &&
      !request.url().includes("limit=6"),
  );
const firstRow = (page: Page) =>
  page.locator(".explore-page [data-row='resolved']").first();

test.describe("screener column sorting", () => {
  test.skip(
    ({ isMobile }) => !!isMobile,
    "the screener renders cards, not a table head, on phones",
  );

  test("each sortable header cycles descending, ascending, then back to the default", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(firstRow(page)).toBeAttached();
    const expectDefault = async () => {
      for (const other of sortable)
        await expect(header(page, other.column)).toHaveAttribute(
          "aria-sort",
          other.column === defaultColumn ? "descending" : "none",
        );
      await expect(header(page, defaultColumn)).toContainText("↓");
    };
    await expectDefault();

    for (const { label, key, column } of sortable) {
      const cell = header(page, column);
      const button = cell.getByRole("button", { name: new RegExp(label, "i") });

      /* The default column already reads descending, so its first click is
         the ascending one and the cycle has nothing to deselect past. */
      if (column !== defaultColumn) {
        const descending = exploreRequest(page);
        await button.click();
        await descending;
        await expect(cell).toHaveAttribute("aria-sort", "descending");
        await expect(button).toContainText("↓");
        expect(search(page).get("sort"), `${key} sort`).toBe(key);
        expect(search(page).get("dir"), `${key} direction`).toBe("desc");
        await expect(
          header(page, defaultColumn),
          "only one header claims the order",
        ).toHaveAttribute("aria-sort", "none");
      }

      const ascending = exploreRequest(page);
      await button.click();
      await ascending;
      await expect(cell).toHaveAttribute("aria-sort", "ascending");
      await expect(button).toContainText("↑");
      expect(search(page).get("sort")).toBe(key);
      expect(search(page).get("dir")).toBe("asc");

      const cleared = exploreRequest(page);
      await button.click();
      await cleared;
      expect(search(page).get("sort"), "deselect clears sort").toBeNull();
      expect(search(page).get("dir"), "deselect clears dir").toBeNull();
      /* Deselect restores the default order and its header. */
      await expectDefault();
      if (column !== defaultColumn)
        await expect(button).not.toContainText(/[↑↓]/);
      await expect(firstRow(page)).toBeAttached();
    }
  });

  test("the chosen order reaches the API and the other columns stay plain", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(firstRow(page)).toBeAttached();

    const request = exploreRequest(page);
    await header(page, 6)
      .getByRole("button", { name: /trades/i })
      .click();
    const sent = new URL((await request).url()).searchParams;
    expect(sent.get("sort")).toBe("trades");
    expect(sent.get("direction")).toBe("desc");
    await expect(firstRow(page)).toBeAttached();

    for (const label of plain) {
      const cell = head(page).locator("th").filter({ hasText: label });
      await expect(cell, `${label} carries no extra copy`).toHaveText(label);
      await expect(cell.locator("button")).toHaveCount(0);
      await expect(cell).not.toHaveAttribute("aria-sort", /.*/);
    }
    /* The old dropdown and its direction toggle are gone from the toolbar. */
    const toolbar = page.locator(".explore-toolbar");
    await expect(toolbar.locator("select")).toHaveCount(0);
    await expect(toolbar).not.toContainText("High to low");
    await expect(toolbar).not.toContainText("Low to high");
  });

  test("headers sort from the keyboard and carry the export's type", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(firstRow(page)).toBeAttached();

    const cell = header(page, 4);
    const button = cell.getByRole("button", { name: /change/i });
    await button.focus();
    await expect(button).toBeFocused();

    await button.press("Enter");
    await expect(cell).toHaveAttribute("aria-sort", "descending");
    expect(search(page).get("sort")).toBe("change");

    await button.press(" ");
    await expect(cell).toHaveAttribute("aria-sort", "ascending");
    expect(search(page).get("dir")).toBe("asc");

    await button.press("Enter");
    await expect(cell).toHaveAttribute("aria-sort", "none");
    await expect(header(page, defaultColumn)).toHaveAttribute(
      "aria-sort",
      "descending",
    );
    expect(search(page).get("sort")).toBeNull();
    await expect(
      button,
      "the header keeps focus through the cycle",
    ).toBeFocused();

    const type = await button.evaluate((node) => {
      const style = getComputedStyle(node);
      return {
        fontSize: style.fontSize,
        fontWeight: Number(style.fontWeight),
        transform: style.textTransform,
        spacing: style.letterSpacing,
      };
    });
    expect(type.fontSize, "the export sets 11.5px headers").toBe("11.5px");
    expect(type.fontWeight, "the export leaves headers at 400").toBe(400);
    expect(type.transform).toBe("uppercase");
    expect(px(type.spacing), "0.04em tracking").toBeCloseTo(11.5 * 0.04, 1);
  });

  test("the header row keeps the export's geometry through the cycle", async ({
    page,
  }, testInfo) => {
    await page.goto("/");
    await expect(firstRow(page)).toBeAttached();
    /* A non-default column walks through all three looks. */
    const button = header(page, 4).getByRole("button", { name: /change/i });
    const measure = () =>
      head(page).evaluate((node) => {
        const table = node.closest("table")!;
        const scroll = table.parentElement!;
        const cells = [...node.querySelectorAll("th")];
        return {
          rowHeight: node.getBoundingClientRect().height,
          columns: cells.map((cell) =>
            Number(cell.getBoundingClientRect().width.toFixed(1)),
          ),
          /* A label wider than its column spills over the next header and
             swallows its clicks, so no header may exceed its own cell. */
          clipped: cells
            .filter((cell) => cell.scrollWidth > cell.clientWidth)
            .map(
              (cell) =>
                `${cell.textContent} by ${cell.scrollWidth - cell.clientWidth}px`,
            ),
          /* Logged, not asserted: these cells already overflow on main, which
             is what .table-scroll absorbs. */
          body: [...table.querySelectorAll("tbody tr:first-child td")].map(
            (cell) => cell.scrollWidth - cell.clientWidth,
          ),
          overflow: table.scrollWidth - scroll.clientWidth,
        };
      });

    const states: (Awaited<ReturnType<typeof measure>> & {
      state: string;
    })[] = [];
    for (const state of ["default", "descending", "ascending"]) {
      states.push({ state, ...(await measure()) });
      await testInfo.attach(`header-${state}`, {
        body: await page.locator(".explore-page .panel").first().screenshot(),
        contentType: "image/png",
      });
      await button.click();
      await expect(firstRow(page)).toBeAttached();
    }
    console.log(JSON.stringify(states));
    await testInfo.attach("header-geometry", {
      body: JSON.stringify(states, null, 2),
      contentType: "application/json",
    });
    for (const state of states) {
      /* The export sets this row at 34px and never reflows it while sorting. */
      expect(state.rowHeight, `${state.state} row height`).toBe(34);
      expect(state.clipped, `${state.state} headers fit`).toEqual([]);
      expect(state.columns, `${state.state} columns`).toEqual(
        states[0].columns,
      );
      expect(
        state.overflow,
        `${state.state} table fits its panel`,
      ).toBeLessThanOrEqual(0);
    }
  });
});
