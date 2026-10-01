import { expect, test, type Page } from "@playwright/test";
import axe from "axe-core";
import chain from "../../data/snapshots/chain.json";
import { poolHref } from "@pools/core";

const wallet = "0x474583e46d2ea052fb5690bdebdb41d6cf1ebce1";

/** Every page a reader lands on, including the empty states that render
    `EmptyState`'s own heading under the page's h1. */
const routes = [
  { name: "home", path: "/", settled: ".pool-table [data-row='resolved']" },
  {
    name: "home watchlist",
    path: "/?view=watchlist",
    settled: "main .empty-state",
  },
  {
    name: "traders",
    path: "/traders/",
    settled: ".desktop-traders [data-row='resolved']",
  },
  {
    name: "traders following",
    path: "/traders/?view=following",
    settled: "main .empty-state",
  },
  {
    name: "pool",
    path: poolHref(chain.markets[0]),
    settled: ".nullable-pool-page[aria-busy='false']",
  },
  {
    name: "wallet",
    path: `/wallet/${wallet}/?window=All`,
    settled: ".wallet-page [data-row='resolved']",
  },
  {
    name: "creators",
    path: "/creators/",
    settled: ".creators-page [data-row='resolved']",
  },
  {
    name: "creator",
    path: `/creators/${chain.markets[0].launchSender}/`,
    settled: ".live-section [data-row='resolved']",
  },
] as const;

async function violations(page: Page) {
  await page.addScriptTag({ content: axe.source });
  return page.evaluate(async () => {
    const result = await (
      window as typeof window & { axe: typeof axe }
    ).axe.run(document, {
      runOnly: {
        type: "rule",
        values: [
          "heading-order",
          "page-has-heading-one",
          "empty-heading",
          "button-name",
          "link-name",
        ],
      },
    });
    return result.violations.map(({ id, nodes }) => ({
      id,
      nodes: nodes.map(({ target }) => target.join(" ")),
    }));
  });
}

/** The visible heading outline: one h1, and no level more than one deeper
    than the heading before it. */
async function outline(page: Page) {
  return page.locator("h1, h2, h3, h4, h5, h6").evaluateAll((nodes) =>
    nodes
      .filter((node) => (node as HTMLElement).offsetParent !== null)
      .map((node) => ({
        level: Number(node.tagName[1]),
        text: (node.textContent ?? "").trim().slice(0, 60),
      })),
  );
}

/** Every link that opens a new tab says so in its accessible name and cannot
    reach back into this page. */
async function unannouncedNewTabs(page: Page) {
  return page.locator("a[target='_blank']").evaluateAll((links) =>
    links
      .filter((link) => {
        const named =
          link.getAttribute("aria-label")?.endsWith("(opens in a new tab)") ??
          link.querySelector(":scope > .sr-only")?.textContent?.trim() ===
            "(opens in a new tab)";
        const rel = (link.getAttribute("rel") ?? "").split(/\s+/);
        return !named || !rel.includes("noopener");
      })
      .map((link) => link.outerHTML.slice(0, 160)),
  );
}

test.describe("headings, toggle names and new-tab links", () => {
  test.skip(({ isMobile }) => isMobile, "the axe sweep runs at 1440");
  test.use({ viewport: { width: 1440, height: 1000 } });

  for (const route of routes) {
    test(`${route.name} has one h1, no skipped level and named controls`, async ({
      page,
    }) => {
      await page.goto(route.path);
      await expect(page.locator(route.settled).first()).toBeAttached();
      expect(await violations(page)).toEqual([]);
      const headings = await outline(page);
      expect(
        headings.filter((h) => h.level === 1),
        JSON.stringify(headings),
      ).toHaveLength(1);
      const skips = headings.filter(
        (h, i) => i > 0 && h.level > headings[i - 1].level + 1,
      );
      expect(skips, JSON.stringify(headings)).toEqual([]);
      expect(await unannouncedNewTabs(page)).toEqual([]);
    });
  }
});

test("an explorer link names its new tab", async ({ page, isMobile }) => {
  test.skip(isMobile, "one width is enough for a name");
  await page.goto(`/wallet/${wallet}/?window=All`);
  const explorer = page.getByRole("link", {
    name: "Explorer ↗ (opens in a new tab)",
    exact: true,
  });
  await expect(explorer).toHaveAttribute("target", "_blank");
  await expect(explorer).toHaveAttribute("rel", "noopener noreferrer");
  // The notice is for assistive tech only: the painted label is unchanged.
  await expect(explorer.locator(".sr-only")).toHaveCSS("position", "absolute");
  expect(
    await explorer.evaluate((link) => {
      const clone = link.cloneNode(true) as HTMLElement;
      clone.querySelector(".sr-only")?.remove();
      return clone.textContent;
    }),
  ).toBe("Explorer ↗");
});
