import { expect, test, type Page } from "@playwright/test";
import axe from "axe-core";

/* Tab must follow the page as it reads (WCAG 2.4.3): the header left to
   right and row by row, and inside a traders card or row its identity
   before the Follow toggle drawn at its right. Each stop names itself,
   carries the focus ring and is rendered, so no stop lands on a copy that
   is hidden at this width. */

type Stop = {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  ring: string;
  visible: boolean;
};

async function tab(page: Page): Promise<Stop> {
  await page.keyboard.press("Tab");
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return {
      name: (el.getAttribute("aria-label") ?? el.textContent ?? "").trim(),
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      ring: el.matches(":focus-visible")
        ? `${style.outlineStyle} ${style.outlineWidth}`
        : "none",
      visible:
        rect.width > 0 &&
        rect.height > 0 &&
        el.checkVisibility({ visibilityProperty: true }),
    };
  });
}

/* The next stop reads after this one: on a later line, or on the same line
   further right. */
function readsAfter(previous: Stop, next: Stop) {
  const belowLine = next.y >= previous.y + previous.height - 2;
  const sameLine =
    next.y < previous.y + previous.height &&
    previous.y < next.y + next.height;
  return belowLine || (sameLine && next.x >= previous.x + previous.width - 2);
}

function expectReadingOrder(stops: Stop[]) {
  for (let i = 1; i < stops.length; i++)
    expect(
      readsAfter(stops[i - 1], stops[i]),
      `"${stops[i - 1].name}" @${Math.round(stops[i - 1].x)},${Math.round(stops[i - 1].y)} -> "${stops[i].name}" @${Math.round(stops[i].x)},${Math.round(stops[i].y)}`,
    ).toBe(true);
}

test("Tab follows the header and the traders cards and rows as they read", async ({
  page,
  isMobile,
}) => {
  if (isMobile) await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/traders/");
  await expect(
    page.locator(".trader-podium-card .address-chip").first(),
  ).toBeVisible();
  await expect(
    page
      .locator(
        isMobile
          ? ".mobile-traders [data-row='resolved'] .address-chip"
          : ".desktop-traders [data-row='resolved'] .address-chip",
      )
      .first(),
  ).toBeVisible();

  const stops: Stop[] = [];
  for (let i = 0; i < 60; i++) {
    const stop = await tab(page);
    stops.push(stop);
    if (stops.filter((s) => s.name.startsWith("Follow 0x")).length === 4)
      break;
  }
  for (const stop of stops) {
    expect(stop.visible, `"${stop.name}" rendered`).toBe(true);
    expect(stop.ring, `"${stop.name}" ring`).toBe("solid 2px");
  }

  const names = stops.map((stop) => stop.name);
  const header = isMobile
    ? [
        "Skip to content",
        "Pools Info home",
        "Search tokens, wallets, creators",
        "ETH",
        "USD, price unavailable",
        "You: nothing saved yet",
        "Pools",
        "Traders",
        "Creators",
      ]
    : [
        "Skip to content",
        "Pools Info home",
        "Pools",
        "Traders",
        "Creators",
        "Search tokens, wallets, creators",
        "ETH",
        "USD, price unavailable",
        "You: nothing saved yet",
      ];
  expect(names.slice(0, header.length)).toEqual(
    header.map((name) => expect.stringContaining(name)),
  );
  /* The skip link parks off screen until focused and is not part of the
     header's rows. */
  expectReadingOrder(stops.slice(1, header.length));

  /* The first podium card and the first ranked row: the wallet, its copy
     and explorer actions, then its Follow toggle. */
  const follows = stops.flatMap((stop, i) =>
    stop.name.startsWith("Follow 0x") ? [i] : [],
  );
  for (const index of [follows[0], follows[3]]) {
    const card = stops.slice(index - 3, index + 1);
    const wallet = card[3].name.replace("Follow ", "");
    expect(card.map((stop) => stop.name)).toEqual([
      `${wallet.slice(0, 6)}…${wallet.slice(-4)}`,
      "Copy address",
      "Open address on explorer (opens in a new tab)",
      `Follow ${wallet}`,
    ]);
    expectReadingOrder(card);
  }

  await page.addScriptTag({ content: axe.source });
  const violations = await page.evaluate(async () => {
    const result = await (
      window as typeof window & { axe: typeof axe }
    ).axe.run(document, {
      runOnly: {
        type: "rule",
        values: [
          "tabindex",
          "focus-order-semantics",
          "aria-hidden-focus",
          "nested-interactive",
          "scrollable-region-focusable",
        ],
      },
      rules: { "focus-order-semantics": { enabled: true } },
    });
    return result.violations.map(({ id, nodes }) => ({
      id,
      targets: nodes.map(({ target }) => target),
    }));
  });
  expect(violations).toEqual([]);
});
