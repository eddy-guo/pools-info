import { test, expect } from "@playwright/test";
import { visualTheme, type ObservedMarket } from "@pools/core";
import captured from "../../data/pools/index.json";
import { preloadedProduct } from "../../apps/web/src/lib/product-server";
import { methodologyCopy } from "../support/pool-copy";
const id = "0x" + "1".repeat(64),
  token = "0x" + "2".repeat(40),
  tx = "0x" + "3".repeat(64),
  hash = "0x" + "4".repeat(64);
const pool = {
  poolId: id,
  token,
  name: "Broad observed token",
  symbol: "BOT",
  launch: {
    block: 22754669,
    timestamp: 100000,
    transactionHash: tx,
    transactionInitiator: token,
  },
};
function fixture(): ObservedMarket {
  return {
    poolId: id,
    token,
    decimals: 18,
    priceWei: "2000000000000000000",
    window: "24h",
    volumeWei: "123000000000000000000",
    trades: 21001,
    change: 100,
    observations: [
      {
        id: `${tx}:0`,
        transactionHash: tx,
        logIndex: 0,
        block: 22754679,
        blockHash: hash,
        timestamp: 200000,
        side: "buy",
        ethWei: "1000000000000000000",
        tokenRaw: "500000000000000000",
      },
    ],
    coverage: {
      startBlock: 22754669,
      cutoff: { block: 22754679, hash, asOf: 200000 },
      indexedAt: "2026-09-15T00:00:00.000Z",
      completeWindow: true,
      windowStart: 113600,
      priceBaseline: { block: 22754669, hash, asOf: 113599 },
      unitBasis: {
        block: 22754679,
        hash,
        asOf: 200000,
        decimals: 18,
        source: "broad_token_units",
      },
      unitsConflict: false,
      accounting: "unavailable",
      attribution: "transaction_initiator_only",
    },
    history: {
      priceSemantics: "declared_cutoff_display_units",
      intervalSeconds: 60,
      fromTimestamp: 199980,
      truncated: false,
      candles: [
        {
          time: 199980,
          open: "1000000000000000000",
          high: "2000000000000000000",
          low: "1000000000000000000",
          close: "2000000000000000000",
          volume: "1000000000000000000",
        },
      ],
    },
  };
}
test("broad-only pool uses the real chart and exact market stats, with nothing under them", async ({
  page,
}, testInfo) => {
  await page.route(`**/api/product/pools/${id}/`, (route) =>
    route.fulfill({
      json: {
        pool,
        analytics: null,
        market: fixture(),
        delivery: { source: "indexer", notice: null },
      },
    }),
  );
  await page.goto(`/pool/${id}/`);
  await expect(page.getByRole("heading", { name: pool.name })).toBeVisible();
  await expect(
    page.getByRole("application", { name: /Price candle chart/ }),
  ).toBeVisible();
  await expect(page.locator(".stat > span")).toHaveText([
    "FDV",
    "Volume 24h",
    "Creator fee",
  ]);
  /* Holders, liquidity, fees, top traders and the trade history are cut. */
  await expect(page.locator(".table-tabs, .market-sidebar")).toHaveCount(0);
  const volume = page
    .locator(".stat")
    .filter({ has: page.getByText("Volume 24h", { exact: true }) });
  await expect(volume.locator("strong")).toContainText("123");
  await expect(volume.locator("small")).toHaveText("21,001 trades");
  await page.screenshot({
    path: testInfo.outputPath("broad-pool.png"),
    fullPage: true,
  });
  await expect(page.locator("body")).not.toContainText(methodologyCopy);
  await expect(page.locator(".pool-chart-panel select")).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
/* The chart draws its price-scale labels on a canvas, so the labels are
   measured where they are painted: a label is whole when no ink reaches the
   first or last pixel row of its pane's axis. The library centres a label on
   its tick and, unless the scale is told `entireTextOnly`, lets an edge tick's
   label run past the pane (the topmost label cut in half on production). One
   bar spanning 0.73 to 1.33 millionths of an ETH puts the 0.0₅1500 tick 0.8px
   under the top of the desktop's 291px price pane (default margins, a tick
   every 0.0₆1000): unfixed, that label's lower half showed in the top rows;
   fixed, the tick is dropped and the scale starts at 0.0₅1400 about 35px
   down. The bar stays under the library's 2^53/100 safe value, which its
   development build asserts on. */
test("price-scale labels stay whole at the edges of every pane", async ({
  page,
}, testInfo) => {
  const market = fixture();
  market.priceWei = "1330000000000";
  market.history.candles = [
    {
      time: 199980,
      open: "730000000000",
      high: "1330000000000",
      low: "730000000000",
      close: "1330000000000",
      volume: "1000000000000000000",
    },
  ];
  await page.route(`**/api/product/pools/${id}/`, (route) =>
    route.fulfill({
      json: {
        pool,
        analytics: null,
        market,
        delivery: { source: "indexer", notice: null },
      },
    }),
  );
  await page.goto(`/pool/${id}/`);
  await expect(page.locator(".interactive-chart canvas").first()).toBeVisible();
  /* Each pane row of the chart's table holds the pane and its right price
     axis; the time axis row is the last. Ink is any pixel past the axis
     border at half the label colour's contrast or more, so the antialiased
     fringe of a whole label never counts. Bands are the runs of rows that
     carry ink: one per label. */
  const rgb = (hex: string) =>
    [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
  const scan = () =>
    page.evaluate(
      ({ fill, text }) => {
        const rows = [
          ...document.querySelectorAll(".interactive-chart table tr"),
        ].filter((row) => row.children.length === 3);
        const distance = (a: number[], b: number[]) =>
          a.reduce((sum, channel, i) => sum + Math.abs(channel - b[i]), 0);
        const threshold = distance(text, fill) / 2;
        return rows.slice(0, -1).map((row) => {
          const canvas = row.children[2].querySelector("canvas")!;
          const { width, height } = canvas;
          const pixels = canvas
            .getContext("2d")!
            .getImageData(0, 0, width, height).data;
          const inkAt = (y: number) => {
            for (let x = 2; x < width; x++) {
              const i = (y * width + x) * 4;
              if (distance([...pixels.subarray(i, i + 3)], fill) >= threshold)
                return true;
            }
            return false;
          };
          const bands: [number, number][] = [];
          for (let y = 0, start = -1; y <= height; y++) {
            const ink = y < height && inkAt(y);
            if (ink && start < 0) start = y;
            if (!ink && start >= 0) {
              bands.push([start, y - 1]);
              start = -1;
            }
          }
          return { height, bands };
        });
      },
      { fill: rgb(visualTheme.panel), text: rgb(visualTheme.muted) },
    );
  await expect
    .poll(async () => (await scan())[0]?.bands.length ?? 0, {
      message: "the price pane has drawn its labels",
    })
    .toBeGreaterThanOrEqual(3);
  const panes = await scan();
  expect(panes, "a price pane over a volume pane").toHaveLength(2);
  for (const [name, { height, bands }] of [
    ["price", panes[0]],
    ["volume", panes[1]],
  ] as const) {
    expect(bands.length, `the ${name} pane shows labels`).toBeGreaterThan(0);
    for (const [top, bottom] of bands) {
      expect(
        top,
        `a ${name} label clear of the pane's top edge`,
      ).toBeGreaterThan(0);
      expect(
        bottom,
        `a ${name} label clear of the pane's bottom edge`,
      ).toBeLessThan(height - 1);
    }
  }
  /* The fixture only proves anything while its edge tick is where the
     geometry above puts it: the first label shown is the 0.0₅1400 tick on the
     desktop (about 35px down) and, on the phone's 183px pane with a tick every
     0.0₆2000, the same value about 22px down. */
  const [firstTop] = panes[0].bands[0];
  const expected = testInfo.project.name === "desktop" ? [28, 40] : [15, 27];
  expect(
    firstTop,
    "the top label sits where the fixture's geometry puts it",
  ).toBeGreaterThanOrEqual(expected[0]);
  expect(firstTop).toBeLessThanOrEqual(expected[1]);
});
/* The All range fits every bar into the plot, but a young pool's few bars
   stop growing at a 32px slot and sit centred rather than at the right edge
   of an otherwise empty plot (QA item 22: a 40-slot window put one to three
   candles in its last few slots). A pool with more bars than that fills the
   plot edge to edge, as before. Candle ink is measured on the price pane's
   canvas: a column is a bar's when four or more of its pixels carry the up
   or down colour, which the one-pixel dotted price line never does. */
for (const [count, shape] of [
  [1, "a lone bar sits centred, one slot wide"],
  [3, "three bars sit centred, a slot apiece"],
  [90, "a long history fills the plot"],
] as const) {
  test(`All range on ${count} bar(s): ${shape}`, async ({ page }) => {
    const market = fixture();
    const last = 199980;
    market.history.fromTimestamp = last - 60 * (count - 1);
    market.history.candles = Array.from({ length: count }, (_, i) => ({
      time: last - 60 * (count - 1 - i),
      open: i % 2 ? "2000000000000000000" : "1000000000000000000",
      high: "2000000000000000000",
      low: "1000000000000000000",
      close: i % 2 ? "1000000000000000000" : "2000000000000000000",
      volume: "1000000000000000000",
    }));
    await page.route(`**/api/product/pools/${id}/`, (route) =>
      route.fulfill({
        json: {
          pool,
          analytics: null,
          market,
          delivery: { source: "indexer", notice: null },
        },
      }),
    );
    await page.goto(`/pool/${id}/`);
    await expect(
      page.locator(".pool-chart-head").getByRole("button", { name: "All" }),
    ).toHaveAttribute("aria-pressed", "true");
    const rgb = (hex: string) =>
      [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
    const ink = () =>
      page.evaluate(
        ({ colours }) => {
          const row = [
            ...document.querySelectorAll(".interactive-chart table tr"),
          ].find((r) => r.children.length === 3);
          const canvas = row?.children[1].querySelector("canvas");
          if (!canvas) return null;
          const { width, height } = canvas;
          const ratio = width / canvas.getBoundingClientRect().width;
          const pixels = canvas
            .getContext("2d")!
            .getImageData(0, 0, width, height).data;
          const columns: number[] = [];
          for (let x = 0; x < width; x++) {
            let hits = 0;
            for (let y = 0; y < height; y++) {
              const i = (y * width + x) * 4;
              if (
                colours.some(
                  (c) =>
                    Math.abs(pixels[i] - c[0]) +
                      Math.abs(pixels[i + 1] - c[1]) +
                      Math.abs(pixels[i + 2] - c[2]) <
                    24,
                )
              )
                hits++;
            }
            if (hits >= 4) columns.push(x);
          }
          return columns.length
            ? {
                plot: width / ratio,
                first: columns[0] / ratio,
                last: (columns.at(-1)! + 1) / ratio,
              }
            : null;
        },
        { colours: [rgb(visualTheme.up), rgb(visualTheme.down)] },
      );
    await expect.poll(ink, { message: "the bars are drawn" }).not.toBeNull();
    const { plot, first, last: end } = (await ink())!;
    if (count === 90) {
      expect(first, "the first bar at the plot's left edge").toBeLessThan(
        plot * 0.05,
      );
      expect(end, "the last bar at the plot's right edge").toBeGreaterThan(
        plot * 0.95,
      );
    } else {
      expect(
        Math.abs((first + end) / 2 - plot / 2),
        "the bars centred in the plot",
      ).toBeLessThan(4);
      expect(end - first, "each bar within its 32px slot").toBeLessThanOrEqual(
        32 * count,
      );
      expect(end - first, "each bar wider than a sliver").toBeGreaterThan(
        16 * count,
      );
    }
  });
}
/* A bare pool link has only its observed market, and the ledger's market
   carries the creator-fee flag when it is known. Only a real boolean renders
   a setting: an absent flag is the unavailable mark, never Disabled. */
for (const [creatorFees, expected] of [
  [true, "Enabled"],
  [false, "Disabled"],
  [undefined, "\u2013"],
] as const) {
  test(`observed market with creator fee ${String(creatorFees)} renders ${expected}`, async ({
    page,
  }) => {
    const market = fixture();
    if (creatorFees !== undefined) market.creatorFees = creatorFees;
    await page.route(`**/api/product/pools/${id}/`, (route) =>
      route.fulfill({
        json: {
          pool,
          analytics: null,
          market,
          delivery: { source: "indexer", notice: null },
        },
      }),
    );
    await page.goto(`/pool/${id}/`);
    await expect(page.getByRole("heading", { name: pool.name })).toBeVisible();
    const stat = page
      .locator(".stat")
      .filter({ has: page.getByText("Creator fee", { exact: true }) })
      .locator("strong");
    await expect(stat).toHaveText(
      creatorFees === undefined ? "\u2013Unavailable" : expected,
    );
    if (creatorFees === undefined)
      await expect(
        stat.locator(".unavailable"),
        "a missing flag is unavailable, not an inferred Disabled",
      ).toHaveText("\u2013Unavailable");
  });
}
test("quiet token retains its chart with a dated unit basis after the global market cutoff advances", async ({
  page,
}) => {
  let advanced = false;
  let reads = 0;
  await page.route(`**/api/product/pools/${id}/`, (route) => {
    reads++;
    const market = fixture();
    if (advanced)
      market.coverage.cutoff = {
        block: 22754689,
        hash: "0x" + "5".repeat(64),
        asOf: 200100,
      };
    return route.fulfill({
      json: {
        pool,
        analytics: null,
        market,
        delivery: { source: "indexer", notice: null },
      },
    });
  });
  await page.goto(`/pool/${id}/`);
  await expect(page.getByRole("heading", { name: pool.name })).toBeVisible();
  advanced = true;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect.poll(() => reads).toBe(2);
  await expect(
    page.getByRole("application", { name: /Price candle chart/ }),
  ).toBeVisible();
  await expect(page.locator(".live-price-heading")).toContainText("2");
});
test("direct pool link preserves verified published deep accounting alongside broad market data", async ({
  page,
}) => {
  const snapshot = Object.values(captured.snapshots)[0],
    deep = snapshot.markets[0];
  const payload = (await preloadedProduct(
    `pools/${deep.id}`,
    new URLSearchParams("window=All"),
  )) as Record<string, unknown>;
  const market = fixture();
  Object.assign(market, {
    poolId: deep.id,
    token: deep.token.toLowerCase(),
    observations: [],
    change: null,
  });
  Object.assign(market.coverage, {
    startBlock: deep.launchBlock,
    cutoff: {
      block: snapshot.toBlock + 10,
      hash,
      asOf: snapshot.toTimestamp + 60,
    },
    unitBasis: {
      block: snapshot.toBlock + 10,
      hash,
      asOf: snapshot.toTimestamp + 60,
      decimals: 18,
      source: "broad_token_units",
    },
    windowStart: snapshot.toTimestamp + 60 - 86400,
    priceBaseline: null,
    completeWindow: false,
  });
  Object.assign(market.history, { fromTimestamp: null, candles: [] });
  await page.route(`**/api/product/pools/${deep.id}/`, (route) =>
    route.fulfill({
      json: {
        ...payload,
        pool: {
          poolId: deep.id,
          name: deep.name,
          symbol: deep.symbol,
          token: deep.token.toLowerCase(),
          launch: {
            block: deep.launchBlock,
            timestamp: deep.launchedAt,
            transactionHash: deep.launchTx,
            transactionInitiator: deep.launchSender.toLowerCase(),
          },
        },
        market,
        delivery: { source: "indexer", notice: null },
      },
    }),
  );
  await page.goto(`/pool/${deep.id}/`);
  await expect(page.getByRole("heading", { name: deep.name })).toBeVisible();
  /* The accounted market is what knows the pool's creator fee setting. */
  await expect(
    page
      .locator(".stat")
      .filter({ has: page.getByText("Creator fee", { exact: true }) })
      .locator("strong"),
  ).toHaveText(deep.creatorFees ? "Enabled" : "Disabled");
});
test("discovered-only pool shows no invented zero totals", async ({ page }) => {
  const market = fixture();
  Object.assign(market, {
    decimals: null,
    priceWei: null,
    volumeWei: null,
    trades: null,
    change: null,
    observations: [],
  });
  Object.assign(market.coverage, {
    startBlock: null,
    cutoff: null,
    indexedAt: null,
    completeWindow: false,
    windowStart: null,
    priceBaseline: null,
    unitBasis: null,
  });
  Object.assign(market.history, { fromTimestamp: null, candles: [] });
  await page.route(`**/api/product/pools/${id}/`, (route) =>
    route.fulfill({
      json: {
        pool,
        analytics: null,
        market,
        delivery: { source: "indexer", notice: null },
      },
    }),
  );
  await page.goto(`/pool/${id}/`);
  await expect(page.getByRole("heading", { name: pool.name })).toBeVisible();
  const volume = page
    .locator(".stat")
    .filter({ has: page.getByText("Volume 24h", { exact: true }) });
  await expect(
    volume.locator("strong .unavailable"),
    "Volume 24h carries the quiet mark, never an invented zero",
  ).toHaveText("\u2013Unavailable");
  await expect(
    volume.locator("small"),
    "no trade count is invented under it",
  ).toHaveCount(0);
});
test("a pool whose saved launch arrives as decimal strings still renders its identity", async ({
  page,
}) => {
  await page.route(`**/api/product/pools/${id}/`, (route) =>
    route.fulfill({
      json: {
        // A bigint column read as text serialises these three as strings.
        pool: {
          ...pool,
          launch: {
            block: String(pool.launch.block),
            timestamp: String(pool.launch.timestamp),
            transactionHash: tx,
            transactionInitiator: token,
            sourceBatchThroughBlock: "22754729",
          },
        },
        analytics: null,
        market: fixture(),
        delivery: { source: "indexer", notice: null },
      },
    }),
  );
  await page.goto(`/pool/${id}/`);
  await expect(page.getByRole("heading", { name: pool.name })).toBeVisible();
  await expect(page.getByText("Pool outside current coverage")).toHaveCount(0);
  await expect(page.locator(".pool-launch-meta")).toHaveText(
    /^launched \d+d ago by /,
  );
  await expect(page.locator(".pool-launch-meta time")).toHaveAttribute(
    "title",
    "1970-01-02 03:46:40 UTC",
  );
  await expect(
    page
      .locator(".stat")
      .filter({ has: page.getByText("Volume 24h", { exact: true }) })
      .locator("small"),
  ).toHaveText("21,001 trades");
});

/* Synthetic prices exercise the library boundary; they are not claims about
   current pools. Run these against next dev as well as the built server: only
   the development library validates the magnitude passed to setData. */
for (const sample of [
  {
    name: "one-wei",
    unit: 1n,
    eth: ["0.0171 ETH", "0.0172 ETH", "0.0171 ETH", "0.0172 ETH"],
    usd: ["$0.0144000", "$0.0148000", "$0.0144000", "$0.0148000"],
    axisClose: "0.0₁₇2000",
  },
  {
    name: "ordinary",
    unit: 1_000_000_000_000n,
    eth: ["0.051000 ETH", "0.052000 ETH", "0.051000 ETH", "0.052000 ETH"],
    usd: ["$0.004", "$0.008", "$0.004", "$0.008"],
    axisClose: "0.0₅2000",
  },
  {
    name: "high",
    unit: 1_000_000_000_000_000_000n,
    eth: ["1 ETH", "2 ETH", "1 ETH", "2 ETH"],
    usd: ["$4,000.00", "$8,000.00", "$4,000.00", "$8,000.00"],
    axisClose: "2",
  },
]) {
  test(`${sample.name} candle prices retain OHLC, keyboard coordinates and ETH/USD semantics`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    /* Observe the painted crosshair label, not a component test handle. The
       tooltip alone would pass if the keyboard still sent unscaled wei to
       setCrosshairPosition and placed the actual crosshair off the pane. */
    await page.addInitScript(() => {
      const labels = new WeakMap<HTMLCanvasElement, string[]>();
      const proto = CanvasRenderingContext2D.prototype;
      const fill = proto.fillText;
      const clear = proto.clearRect;
      proto.clearRect = function (...args) {
        labels.set(this.canvas, []);
        return clear.apply(this, args);
      };
      proto.fillText = function (...args) {
        const current = labels.get(this.canvas) ?? [];
        current.push(args[0]);
        labels.set(this.canvas, current);
        return fill.apply(this, args);
      };
      Object.assign(window, {
        candleLabels: (canvas: HTMLCanvasElement) => labels.get(canvas) ?? [],
      });
    });
    const market = fixture();
    market.priceWei = String(4n * sample.unit);
    market.change = 300;
    market.history.fromTimestamp = 199200;
    market.history.candles = [199200, 199980].map((time, i) => {
      const open = sample.unit * BigInt(i + 1);
      return {
        time,
        open: String(open),
        high: String(open * 2n),
        low: String(open),
        close: String(open * 2n),
        volume: "1000000000000000000",
      };
    });
    await page.route(`**/api/product/pools/${id}/`, (route) =>
      route.fulfill({
        json: {
          pool,
          analytics: null,
          market,
          delivery: { source: "indexer", notice: null },
        },
      }),
    );
    await page.route("**/api/product/prices/eth-usd/", (route) =>
      route.fulfill({
        json: {
          usdPerEth: 4000,
          asOf: "2026-09-21T00:00:00.000Z",
          source: "coinbase",
        },
      }),
    );
    await page.goto(`/pool/${id}/`);
    const chart = page.getByRole("application", { name: /Price candle chart/ });
    await expect(chart.locator("canvas").first()).toBeVisible();
    await page.getByRole("button", { name: "All", exact: true }).click();
    await chart.focus();
    await chart.press("ArrowLeft");
    const tooltip = page.locator(".chart-tooltip");
    await expect(tooltip.locator(".price")).toHaveText(sample.eth);
    await expect(tooltip.locator("time")).toHaveAttribute(
      "datetime",
      new Date(199200 * 1000).toISOString(),
    );
    const crosshairAxis = chart
      .locator("table tr")
      .first()
      .locator("td")
      .nth(2)
      .locator("canvas")
      .nth(1);
    const axisLabels = () =>
      crosshairAxis.evaluate((canvas) =>
        (
          window as unknown as {
            candleLabels: (canvas: HTMLCanvasElement) => string[];
          }
        ).candleLabels(canvas as HTMLCanvasElement),
      );
    await expect.poll(axisLabels).toContain(sample.axisClose);
    await expect(page.locator(".live-price-heading .change")).toHaveCount(0);
    const changeWindow = page.locator(".live-changes > span").filter({
      has: page.getByText("24h", { exact: true }),
    });
    await expect(changeWindow).toHaveCount(1);
    const change = changeWindow.locator(".change");
    await expect(change).toHaveText("+300.00%");
    const units = page.locator(".header-actions .unit-toggle");
    await units.getByRole("button", { name: "USD", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(tooltip.locator(".price")).toHaveText(sample.usd);
    await expect(tooltip.locator(":scope > span").last()).toHaveText(
      "V$4,000.00",
    );
    await expect(change).toHaveText("+300.00%");
    // The candle axis remains ETH, as before; the unit toggle converts the
    // exact source values through Price/Eth, never chart coordinates.
    await expect.poll(axisLabels).toContain(sample.axisClose);
    await units.getByRole("button", { name: "ETH", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(tooltip.locator(".price")).toHaveText(sample.eth);
    if (sample.name === "high") {
      market.priceWei = String(BigInt(market.priceWei!) * 10n);
      for (const candle of market.history.candles) {
        for (const field of ["open", "high", "low", "close"] as const)
          candle[field] = String(BigInt(candle[field]) * 10n);
      }
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      await expect(tooltip.locator(".price")).toHaveText([
        "10 ETH",
        "20 ETH",
        "10 ETH",
        "20 ETH",
      ]);
      await chart.focus();
      await chart.press("ArrowLeft");
      await expect.poll(axisLabels).toContain("20");
    }
    expect(errors).toEqual([]);
  });
}
