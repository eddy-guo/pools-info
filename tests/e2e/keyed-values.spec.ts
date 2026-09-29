import { expect, test } from "@playwright/test";

const wallet = "0x474583e46d2ea052fb5690bdebdb41d6cf1ebce1";

for (const value of [
  {
    name: "Money",
    url: `/wallet/${wallet}/?window=All`,
    read: "/api/product/wallets/",
    selector: ".wallet-chart-region .chart-readout .number",
  },
  {
    name: "Price",
    url: "/?sort=volume&window=All",
    read: "/api/product/explore/",
    selector: ".explore-page .desktop-pools [data-row-index='0'] .price",
  },
].flatMap((value) =>
  (["ETH", "USD"] as const).map((unit) => ({ ...value, unit })),
)) {
  test(`${value.name} ${value.unit} replaces its pending text without layout shift`, async ({
    page,
  }, testInfo) => {
    if (testInfo.project.name === "mobile")
      await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(
      (unit) => localStorage.setItem("poolsinfo.unit.v1", unit),
      value.unit,
    );
    await page.addInitScript(() => {
      const state = { cls: 0, valueCls: 0, shifts: [] as unknown[] };
      Object.assign(window, { valueShifts: state });
      new PerformanceObserver((list) => {
        for (const raw of list.getEntries()) {
          const shift = raw as PerformanceEntry & {
            hadRecentInput: boolean;
            value: number;
            sources?: { node: Node | null }[];
          };
          if (!shift.hadRecentInput) {
            state.cls += shift.value;
            const { pendingSlot: slot, pendingContent } = window as unknown as {
              pendingSlot?: Node;
              pendingContent?: Node;
            };
            if (
              slot &&
              shift.sources?.some(
                (source) =>
                  source.node &&
                  (source.node === slot ||
                    source.node === pendingContent ||
                    slot.contains(source.node)),
              )
            )
              state.valueCls += shift.value;
            state.shifts.push({
              value: shift.value,
              sources: shift.sources?.map(
                (source) => source.node?.parentElement?.className ?? null,
              ),
            });
          }
        }
      }).observe({ type: "layout-shift", buffered: true });
    });

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/product/prices/eth-usd/", (route) =>
      route.fulfill({
        json: {
          usdPerEth: 4218.44,
          asOf: "2026-09-17T00:00:00.000Z",
          source: "coinbase",
        },
      }),
    );
    await page.route(`**${value.read}**`, async (route) => {
      const response = await route.fetch();
      await gate;
      await route.fulfill({ response });
    });
    try {
      await page.goto(value.url);
      const selector =
        value.name === "Price" && testInfo.project.name === "mobile"
          ? value.selector.replace("desktop-pools", "mobile-pools")
          : value.selector;
      const slot = page.locator(selector).first();
      await expect(slot).toHaveText("Pending");
      await slot.scrollIntoViewIfNeeded();
      await page.evaluate(() =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
      );
      await slot.evaluate((node) => {
        Object.assign(window, {
          pendingSlot: node,
          pendingContent: node.firstChild,
        });
        const shifts = (
          window as unknown as {
            valueShifts: { cls: number; valueCls: number; shifts: unknown[] };
          }
        ).valueShifts;
        shifts.cls = 0;
        shifts.valueCls = 0;
        shifts.shifts = [];
      });
      release();
      await expect(slot).not.toHaveText("Pending");
      await expect(slot).not.toHaveAttribute("data-pending", "true");
      await page.evaluate(() =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
      );
      const result = await slot.evaluate((node) => ({
        sameSlot:
          node === (window as unknown as { pendingSlot: Node }).pendingSlot,
        newContent:
          node.firstChild !==
          (window as unknown as { pendingContent: Node }).pendingContent,
        shifts: (
          window as unknown as {
            valueShifts: { cls: number; valueCls: number; shifts: unknown[] };
          }
        ).valueShifts,
      }));
      await testInfo.attach("value-shifts", {
        body: JSON.stringify(result),
        contentType: "application/json",
      });
      expect(result.sameSlot, "the value keeps its reserved outer slot").toBe(
        true,
      );
      expect(
        await page.evaluate(
          () =>
            (window as unknown as { pendingContent: Node }).pendingContent
              .nodeType,
        ),
        "the placeholder has its own remountable element",
      ).toBe(1);
      expect(result.newContent, "the pending text is replaced as a node").toBe(
        true,
      );
      expect(result.shifts.valueCls, "the value resolves with CLS 0").toBe(0);
    } finally {
      release();
    }
  });
}
