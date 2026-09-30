import { test, expect } from "@playwright/test";
import chain from "../../data/snapshots/chain.json";
import { poolHref } from "@pools/core";

const axePath = require.resolve("axe-core/axe.min.js", {
  paths: [require.resolve("@playwright/test")],
});

type AxeNode = { target: string[] };
type AxeResult = {
  violations: { id: string; nodes: AxeNode[] }[];
  incomplete: { id: string; nodes: AxeNode[] }[];
};

const pages = [
  { name: "home", url: "/", groups: ["Currency unit", "Pool views"] },
  {
    name: "traders",
    url: "/traders/",
    groups: ["Currency unit", "Trader view", "Ranking metric"],
  },
  {
    name: "pool",
    url: poolHref(chain.markets[0]),
    groups: ["Currency unit", "Chart range"],
  },
];

for (const entry of pages) {
  test(`${entry.name} segments meet contrast and expose named groups`, async ({
    page,
  }) => {
    await page.goto(entry.url);
    for (const name of entry.groups) {
      await expect(page.getByRole("group", { name })).toBeVisible();
    }

    await page.addScriptTag({ path: axePath });
    const findings = await page.evaluate(async () => {
      const axe = (
        window as Window & {
          axe: {
            run: (context: Document, options: object) => Promise<AxeResult>;
          };
        }
      ).axe;
      const result = await axe.run(document, {
        runOnly: {
          type: "rule",
          values: ["color-contrast", "aria-prohibited-attr"],
        },
      });
      const withinControl = (node: AxeNode) => {
        const element = document.querySelector(node.target[0]);
        return Boolean(element?.closest(".segmented, .table-tabs"));
      };
      return {
        contrast: result.violations
          .filter((item) => item.id === "color-contrast")
          .flatMap((item) => item.nodes)
          .filter(withinControl)
          .map((node) => node.target),
        ariaIncomplete: result.incomplete
          .filter((item) => item.id === "aria-prohibited-attr")
          .flatMap((item) => item.nodes)
          .filter(withinControl)
          .map((node) => node.target),
      };
    });
    expect(findings.contrast).toEqual([]);
    expect(findings.ariaIncomplete).toEqual([]);
  });
}
