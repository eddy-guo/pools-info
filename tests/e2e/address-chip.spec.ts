import { test, expect, type Locator, type Page } from "@playwright/test";

/* The screener sender, leaderboard trader and creators sender cells share one
   address chip: identicon, both-end truncation opening the address's page,
   copy with a "Copied" confirmation and an explorer link, at the row's own
   height on both viewports. Creators uses the chip's `size="large"` variant
   (a 28px identicon, the short address on both the name and address lines,
   since no name field exists anywhere in this app), so its shape and
   identicon size diverge from the screener's and leaderboard's shared small
   chip by design, matching the export's row. */

const explorer = "https://robinhoodchain.blockscout.com/address/";
const truncated = /^0x[0-9a-f]{4}…[0-9a-f]{4}$/;

type Cell = {
  name: string;
  url: { desktop: string; mobile: string };
  /** Rows or cards holding one chip each, per project. */
  rows: { desktop: string; mobile: string };
  /** The page the address opens. */
  href: RegExp;
  /** Row or card height that must survive the chip, per project. */
  height: { desktop: number; mobile: number };
  /** 16px everywhere except creators' 28px identity tile. */
  identicon: number;
};
const cells: Cell[] = [
  {
    /* The desktop column is on the measured screener; a phone card shows
       its sender only on the launches view. */
    name: "screener sender",
    url: { desktop: "/", mobile: "/?view=new" },
    rows: {
      desktop: ".desktop-pools [data-row='resolved']:has(.address-chip)",
      mobile: ".mobile-pools [data-row='resolved']",
    },
    href: /^\/wallet\/0x[0-9a-f]{40}\/$/,
    height: { desktop: 62, mobile: 168 },
    identicon: 16,
  },
  {
    name: "leaderboard trader",
    url: { desktop: "/traders/?window=All", mobile: "/traders/?window=All" },
    rows: {
      desktop: ".desktop-traders [data-row='resolved']",
      mobile: ".mobile-traders .mobile-trader:has(.address-chip)",
    },
    href: /^\/wallet\/0x[0-9a-f]{40}\/\?window=All$/,
    height: { desktop: 62, mobile: 224 },
    identicon: 16,
  },
  {
    name: "creators sender",
    url: { desktop: "/creators/", mobile: "/creators/" },
    rows: {
      desktop: ".creators-panel [data-row='resolved']",
      mobile: ".creators-panel [data-row='resolved']",
    },
    href: /^\/creators\/0x[0-9a-f]{40}\/$/,
    height: { desktop: 62, mobile: 62 },
    identicon: 28,
  },
];

/** The first rows come from the preloaded dataset's product API, which four
    workers share; give them the patience the creators suite gives its pages. */
const resolving = { timeout: 30_000 };

/** Every chip in the rows, measured against the row that holds it. */
function measure(page: Page, rows: string) {
  return page.evaluate((rows) => {
    const box = (node: Element) => {
      const rect = node.getBoundingClientRect();
      return {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        height: rect.height,
      };
    };
    return [...document.querySelectorAll(rows)].map((row) => {
      const chip = row.querySelector(".address-chip")!;
      const link = chip.querySelector<HTMLAnchorElement>(".address-chip-link")!;
      const copy = chip.querySelector("button")!;
      const open = chip.querySelector<HTMLAnchorElement>("a[target]")!;
      const rowBox = box(row);
      const inside = (node: Element) => {
        const b = box(node);
        return (
          b.left >= rowBox.left - 0.5 &&
          b.right <= rowBox.right + 0.5 &&
          b.top >= rowBox.top - 0.5 &&
          b.bottom <= rowBox.bottom + 0.5
        );
      };
      return {
        height: Math.round(rowBox.height),
        text: link.querySelector(".mono")?.textContent ?? "",
        href: link.getAttribute("href") ?? "",
        title: link.title,
        identicon: box(chip.querySelector(".avatar")!).height,
        explorer: open.href,
        copyLabel: copy.getAttribute("aria-label"),
        copyBox: box(copy),
        openBox: box(open),
        fits: inside(link) && inside(copy) && inside(open),
      };
    });
  }, rows);
}

async function focused(page: Page) {
  return page.evaluate(() => {
    const node = document.activeElement;
    return node
      ? `${node.tagName.toLowerCase()} ${node.getAttribute("aria-label") ?? node.getAttribute("href") ?? ""}`.trim()
      : "";
  });
}

for (const cell of cells) {
  test(`the ${cell.name} cell carries the address chip at the row's height`, async ({
    page,
    context,
  }, testInfo) => {
    const project = testInfo.project.name as "desktop" | "mobile";
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto(cell.url[project]);
    const rows = page.locator(cell.rows[project]);
    await expect(rows.first().locator(".address-chip")).toBeVisible(resolving);
    await page.evaluate(() => document.fonts.ready);
    const chips = await measure(page, cell.rows[project]);
    await testInfo.attach(`${cell.name}-${project}`, {
      body: JSON.stringify(chips),
      contentType: "application/json",
    });
    expect(chips.length, "the page has rows").toBeGreaterThan(0);
    for (const chip of chips) {
      expect(chip.text, "both-end truncation").toMatch(truncated);
      expect(chip.href, "the address opens its page").toMatch(cell.href);
      expect(chip.title, "the full address is the link's title").toMatch(
        /^0x[0-9a-f]{40}$/,
      );
      expect(chip.explorer, "the explorer link").toBe(
        `${explorer}${chip.title}`,
      );
      expect(chip.identicon, "the identity tile's size").toBe(cell.identicon);
      expect(chip.copyLabel).toBe("Copy address");
      expect(chip.fits, "the chip stays inside its row").toBe(true);
      if (project === "mobile") {
        expect(chip.copyBox.bottom - chip.copyBox.top, "copy tap target").toBe(
          44,
        );
        expect(
          chip.openBox.bottom - chip.openBox.top,
          "explorer tap target",
        ).toBe(44);
      }
    }
    expect(
      [...new Set(chips.map((chip) => chip.height))],
      `rows keep ${cell.height[project]}px`,
    ).toEqual([cell.height[project]]);

    /* Copy writes the full address and confirms without moving the row. The
       row is brought fully into view first, so the click itself scrolls
       nothing and the viewport boxes compare like for like. */
    const first = rows.first();
    await first.scrollIntoViewIfNeeded();
    const before = (await first.boundingBox())!;
    const copy = first.getByRole("button", { name: "Copy address" });
    await copy.click();
    const status = first.getByRole("status");
    await expect(status).toHaveText("Copied");
    await expect(status).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      chips[0].title,
    );
    expect(
      await first.boundingBox(),
      "the confirmation reflows nothing",
    ).toEqual(before);
    const rowBox = before;
    const statusBox = (await status.boundingBox())!;
    expect(
      statusBox.y + statusBox.height > rowBox.y &&
        statusBox.y < rowBox.y + rowBox.height,
      "the confirmation shows at its row",
    ).toBe(true);
    if (cell.name === "creators sender")
      expect(
        statusBox.y >= rowBox.y &&
          statusBox.y + statusBox.height <= rowBox.y + rowBox.height,
        "a clipping cell holds the whole confirmation",
      ).toBe(true);

    /* Keyboard: the address, then copy, then explorer. */
    await first.locator(".address-chip-link").focus();
    expect(await focused(page)).toBe(`a ${chips[0].href}`);
    await page.keyboard.press("Tab");
    expect(await focused(page)).toBe("button Copy address");
    await page.keyboard.press("Tab");
    expect(await focused(page)).toBe("a Open address on explorer");
  });
}

test("the screener and leaderboard cells render one shared small chip, creators its own larger one", async ({
  page,
}, testInfo) => {
  const project = testInfo.project.name as "desktop" | "mobile";
  const shapeByCell = new Map<string, string>();
  for (const cell of cells) {
    await page.goto(cell.url[project]);
    const chip: Locator = page
      .locator(cell.rows[project])
      .first()
      .locator(".address-chip");
    await expect(chip).toBeVisible(resolving);
    shapeByCell.set(
      cell.name,
      await chip.evaluate((node) =>
        [...node.querySelectorAll(":not(svg, svg *)")]
          .map(
            (child) =>
              `${child.tagName.toLowerCase()}.${child.classList[0] ?? ""}`,
          )
          .join(">"),
      ),
    );
  }
  expect(
    shapeByCell.get("screener sender"),
    "screener and leaderboard share the small chip markup",
  ).toBe(shapeByCell.get("leaderboard trader"));
  expect(
    shapeByCell.get("creators sender"),
    "creators' large chip carries the name and address lines, not just the address",
  ).not.toBe(shapeByCell.get("screener sender"));
});
