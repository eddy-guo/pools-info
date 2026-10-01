import { expect, test, type Page } from "@playwright/test";
import chain from "../../data/snapshots/chain.json";
import { poolHref } from "@pools/core";

// Both charts are operable from the keyboard: the focusable region is an
// application with its instructions as its name, the arrows step the
// crosshair point by point, Home and End jump to the ends, and a polite live
// region announces the figures the pointer readout shows for that point.

const wallet = "0x474583e46d2ea052fb5690bdebdb41d6cf1ebce1";

const axePath = require.resolve("axe-core/axe.min.js", {
  paths: [require.resolve("@playwright/test")],
});

async function axeViolations(page: Page, selector: string) {
  await page.addScriptTag({ path: axePath });
  return page.evaluate(async (selector) => {
    const axe = (
      window as Window & {
        axe: {
          run: (
            context: object,
          ) => Promise<{ violations: { id: string; nodes: unknown[] }[] }>;
        };
      }
    ).axe;
    const result = await axe.run({ include: [[selector]] });
    return result.violations.map((v) => `${v.id} (${v.nodes.length})`);
  }, selector);
}

const readoutTime = (time: number) =>
  new Date(time * 1000).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  }) + " UTC";

test.beforeEach(async ({ page }, testInfo) => {
  if (testInfo.project.name === "mobile")
    await page.setViewportSize({ width: 390, height: 844 });
});

test("the PnL curve steps by keyboard and announces its readout", async ({
  page,
}) => {
  const read = page.waitForResponse((r) =>
    r.url().includes(`/api/product/wallets/${wallet}/`),
  );
  await page.goto(`/wallet/${wallet}/?window=All`);
  const { curve } = (await (await read).json()) as {
    curve: { time: number; wei: string }[];
  };
  expect(curve.length).toBeGreaterThan(2);
  const region = page.locator(".wallet-chart-region");
  const readout = region.locator(".chart-readout");
  await expect(readout).toHaveAttribute("aria-live", "polite");
  await expect(readout).toHaveAttribute("aria-atomic", "true");
  const chart = region.getByRole("application", {
    name: /Cumulative realized PnL chart\. Use the left and right arrow keys, Home and End/,
  });
  const time = readout.locator("time");
  await expect(time).toHaveText(readoutTime(curve.at(-1)!.time));

  await chart.focus();
  await chart.press("Home");
  await expect(time).toHaveText(readoutTime(curve[0].time));
  await chart.press("ArrowLeft");
  await expect(time).toHaveText(readoutTime(curve[0].time));
  await chart.press("ArrowRight");
  await expect(time).toHaveText(readoutTime(curve[1].time));
  const stepped = await readout.textContent();

  // The keyboard readout is the pointer's readout for the same point.
  await chart.press("End");
  await expect(time).toHaveText(readoutTime(curve.at(-1)!.time));
  const box = (await chart.boundingBox())!;
  const fraction =
    (curve[1].time - curve[0].time) / (curve.at(-1)!.time - curve[0].time);
  // A dispatched pointer move, since the phone project's emulated touch
  // screen sends no hover.
  await chart.dispatchEvent("pointermove", {
    clientX: box.x + box.width * fraction,
    clientY: box.y + box.height / 2,
  });
  await expect(time).toHaveText(readoutTime(curve[1].time));
  expect(await readout.textContent()).toBe(stepped);

  expect(await axeViolations(page, ".wallet-chart-region")).toEqual([]);
});

test("the candle chart steps by keyboard and announces its candle", async ({
  page,
}) => {
  await page.goto(poolHref(chain.markets[0]));
  const chart = page.getByRole("application", {
    name: /Price candle chart with ETH volume\..*Home and End/,
  });
  await expect(chart.locator("canvas").first()).toBeVisible();
  const tooltip = chart.locator(".chart-tooltip");
  const live = chart.locator("[aria-live='polite']");
  await expect(live).toHaveAttribute("aria-atomic", "true");
  await expect(live).toBeEmpty();

  const announced = async () => ({
    time: await live.locator("time").getAttribute("datetime"),
    figures: await live.locator(".number").allTextContents(),
  });
  const shown = async () => ({
    time: await tooltip.locator("time").getAttribute("datetime"),
    figures: await tooltip.locator(".number").allTextContents(),
  });

  await chart.focus();
  await chart.press("End");
  await expect(tooltip).toBeVisible();
  // The visual tooltip is the same figures, kept out of the reading order.
  await expect(tooltip).toHaveAttribute("aria-hidden", "true");
  const last = await shown();
  expect(last.figures).toHaveLength(5);
  expect(await announced()).toEqual(last);
  await expect(live).toContainText(
    /, Open .*, High .*, Low .*, Close .*, Volume /,
  );

  await chart.press("Home");
  await expect.poll(async () => (await shown()).time).not.toBe(last.time);
  const first = await shown();
  expect(await announced()).toEqual(first);
  await chart.press("ArrowLeft");
  expect(await shown()).toEqual(first);
  await chart.press("ArrowRight");
  await expect.poll(async () => (await shown()).time).not.toBe(first.time);
  expect(await announced()).toEqual(await shown());

  expect(await axeViolations(page, ".interactive-chart")).toEqual([]);
});
