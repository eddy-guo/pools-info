import { test, expect, type Page } from "@playwright/test";

const px = (value: string) => Number.parseFloat(value);
/* The headers order by these; every other column stays a plain header. The change column's head names the window it is measured
   over, as the export's does, so the default page reads it as "24h". */
const sortable = [
  { label: "24h", key: "change", column: 4 },
  { label: "Volume", key: "volume", column: 5 },
];
const plain = ["Token", "Price", "Launch sender", "Trend"];
/* With no sort in the URL the screener reads by volume, highest first. */
const defaultColumn = 5;
/* The export's grid at the 1030px the panel gives a 1440px viewport: watch,
   token, price, 24h, volume, launch sender, trend. Liquidity and holders are
   not served, so their columns are gone and the token column takes the room. */
const columns = [44, 438, 116, 98, 112, 122, 100];
/* Price through volume read from the right, as do their heads. */
const rightAligned = [3, 4, 5];

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
    await header(page, 4).getByRole("button", { name: /24h/i }).click();
    const sent = new URL((await request).url()).searchParams;
    expect(sent.get("sort")).toBe("change");
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
    const button = cell.getByRole("button", { name: /24h/i });
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
    const button = header(page, 4).getByRole("button", { name: /24h/i });
    const measure = () =>
      head(page).evaluate((node) => {
        const table = node.closest("table")!;
        const scroll = table.parentElement!;
        const cells = [...node.querySelectorAll("th")];
        /* A figure's own glyphs against its cell's content box (a value fills
           its cell as a block, so the text nodes are what is measured): the
           export right-aligns every number under a right-aligned head. */
        const edges = (row: Element | null) =>
          [...(row?.querySelectorAll("td") ?? [])].map((cell) => {
            const walker = document.createTreeWalker(
              cell,
              NodeFilter.SHOW_TEXT,
            );
            let right = -Infinity;
            for (let text = walker.nextNode(); text; text = walker.nextNode()) {
              if (!text.textContent?.trim()) continue;
              const range = document.createRange();
              range.selectNodeContents(text);
              right = Math.max(right, range.getBoundingClientRect().right);
            }
            const box = cell.getBoundingClientRect();
            const padding = parseFloat(getComputedStyle(cell).paddingRight);
            return right === -Infinity
              ? null
              : Number((box.right - padding - right).toFixed(1));
          });
        return {
          rowHeight: node.getBoundingClientRect().height,
          columns: cells.map((cell) =>
            Number(cell.getBoundingClientRect().width.toFixed(1)),
          ),
          aligned: cells.map((cell) => getComputedStyle(cell).textAlign),
          rightEdges: edges(table.querySelector("[data-row='resolved']")),
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
      expect(state.columns, `${state.state} columns`).toEqual(columns);
      expect(
        state.overflow,
        `${state.state} table fits its panel`,
      ).toBeLessThanOrEqual(0);
      for (const column of rightAligned) {
        expect(state.aligned[column - 1], `${state.state} head ${column}`).toBe(
          "right",
        );
        const edge = state.rightEdges[column - 1];
        if (edge !== null)
          expect(
            Math.abs(edge),
            `${state.state} column ${column} figure sits on the right edge`,
          ).toBeLessThanOrEqual(1);
      }
      expect(
        rightAligned.filter((column) => state.rightEdges[column - 1] !== null)
          .length,
        `${state.state} first row carries figures`,
      ).toBeGreaterThan(0);
    }
  });
});

/* The screener has no liquidity column, so a link that still names that order
   opens the default order and the URL follows at the next change. */
test.describe("a stale liquidity sort in the URL", () => {
  test("opens the default order and leaves the URL at the next change", async ({
    page,
    isMobile,
  }) => {
    const opened = exploreRequest(page);
    await page.goto("/?sort=liquidity&dir=asc");
    const sent = new URL((await opened).url()).searchParams;
    expect(sent.get("sort"), "the request carries the default order").toBe(
      "volume",
    );
    expect(sent.get("direction"), "and its direction").toBe("desc");
    await expect(firstRow(page)).toBeAttached();
    expect(search(page).get("sort"), "the link reads as given").toBe(
      "liquidity",
    );

    if (!isMobile) {
      await expect(header(page, defaultColumn)).toHaveAttribute(
        "aria-sort",
        "descending",
      );
      await expect(header(page, defaultColumn)).toContainText("↓");
      await expect(head(page)).not.toContainText(/liquidity|holders/i);
    }

    const changed = exploreRequest(page);
    await page.getByRole("button", { name: "7d", exact: true }).click();
    const next = new URL((await changed).url()).searchParams;
    expect(next.get("window")).toBe("7d");
    expect(next.get("sort")).toBe("volume");
    expect(
      search(page).get("sort"),
      "the stale order leaves the URL",
    ).toBeNull();
    expect(search(page).get("dir")).toBeNull();
    expect(search(page).get("window")).toBe("7d");
  });

  /* Show more writes the URL without changing the query, and still drops the
     pair rather than carrying it past the first page. The launches list over
     All is the one with more than a page in the saved dataset, and its
     default order is launch. */
  test("leaves the URL at a Show more as well", async ({ page }) => {
    const opened = exploreRequest(page);
    await page.goto("/?view=new&sort=liquidity&dir=asc&window=All");
    await opened;
    await expect(firstRow(page)).toBeAttached();
    const appended = exploreRequest(page);
    await page
      .locator(".explore-page .pagination")
      .getByRole("button", { name: /^Show \d+ more$/ })
      .click();
    const next = new URL((await appended).url()).searchParams;
    expect(next.get("sort")).toBe("launch");
    expect(next.get("direction")).toBe("desc");
    expect(search(page).get("limit")).toBe("50");
    expect(
      search(page).get("sort"),
      "the stale order leaves the URL",
    ).toBeNull();
    expect(search(page).get("dir")).toBeNull();
  });
});
