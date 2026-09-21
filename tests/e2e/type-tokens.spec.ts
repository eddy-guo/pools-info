import { test, expect, type Page } from "@playwright/test";

/* The export's type, colour and control tokens, measured as computed styles
   on the two screens a user sees first. The counts are the design-gap
   report's acceptance for the token pass: no 900 weight anywhere, one head
   label style, the compact text floor outside chips, regular text under a
   quarter of the screener's visible text, and the unavailable mark in the
   faint token or absent. */

const faint = "rgb(122, 122, 133)";
const line = "rgb(26, 26, 31)";
const secondary = [
  "rgb(180, 180, 190)",
  "rgb(154, 154, 164)",
  "rgb(138, 138, 148)",
  faint,
];
/* Compact chips keep their 10px caps; price subscripts are ordinary UI text. */
const chips = ".badge, .subtle-badge, kbd";

function measure(page: Page) {
  return page.evaluate((chips) => {
    const visible = (el: Element) => {
      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height) return false;
      const style = getComputedStyle(el);
      return style.visibility !== "hidden" && style.display !== "none";
    };
    const all = [...document.querySelectorAll("body *")].filter(
      (el) => !(el instanceof SVGElement) && visible(el),
    );
    const text = all.filter((el) =>
      [...el.childNodes].some(
        (node) => node.nodeType === 3 && node.textContent!.trim(),
      ),
    );
    const describe = (el: Element) =>
      `${el.tagName.toLowerCase()}.${[...el.classList].join(".")} "${el.textContent!.trim().slice(0, 24)}"`;
    return {
      textNodes: text.length,
      weight900: all
        .filter((el) => getComputedStyle(el).fontWeight === "900")
        .map(describe),
      heavy: text.filter((el) => Number(getComputedStyle(el).fontWeight) >= 600)
        .length,
      heads: [...document.querySelectorAll("th")].filter(visible).map((th) => {
        const style = getComputedStyle(th);
        return `${style.fontSize}/${style.fontWeight}/${style.textTransform}`;
      }),
      under11: text
        .filter(
          (el) =>
            parseFloat(getComputedStyle(el).fontSize) < 11 &&
            !el.closest(chips),
        )
        .map(describe),
      panels: [...document.querySelectorAll(".panel")]
        .filter(visible)
        .map((panel) => getComputedStyle(panel).borderTopColor),
      unavailable: [...document.querySelectorAll(".unavailable")]
        .filter(visible)
        .map((el) => {
          const style = getComputedStyle(el);
          return {
            color: style.color,
            weight: style.fontWeight,
            text: el.textContent!.trim(),
            inStat: !!el.closest(".stat"),
          };
        }),
      segmented: [...document.querySelectorAll(".segmented")]
        .filter(visible)
        .map((control) => ({
          height: control.getBoundingClientRect().height,
          buttons: [...control.querySelectorAll("button")].map(
            (button) => button.getBoundingClientRect().height,
          ),
          font: [...control.querySelectorAll("button")].map((button) => {
            const style = getComputedStyle(button);
            return `${style.fontSize}/${style.fontWeight}`;
          }),
        })),
      buttons: [...document.querySelectorAll(".button")]
        .filter(visible)
        .map((button) => ({
          height: button.getBoundingClientRect().height,
          fontSize: getComputedStyle(button).fontSize,
        })),
      colors: [
        ...new Set(
          text
            .filter(
              (el) =>
                !el.closest(
                  ".avatar, .positive, .negative, .button, .skip-link, .podium-rank, .leaderboard-cta, .trader-podium-card-rank",
                ),
            )
            .map((el) => getComputedStyle(el).color),
        ),
      ],
      rail: [...document.querySelectorAll(".stream-event strong")]
        .filter(visible)
        .map((el) => {
          const style = getComputedStyle(el);
          return `${style.fontSize}/${style.fontWeight}`;
        }),
      screenerSubscripts: [
        ...document.querySelectorAll(".desktop-pools .price sub"),
      ]
        .filter(visible)
        .map((el) => {
          const style = getComputedStyle(el);
          return `${style.fontSize}/${style.fontWeight}`;
        }),
      avatars: [...document.querySelectorAll(".avatar")]
        .filter(visible)
        .map((el) => ({
          background: getComputedStyle(el).backgroundColor,
          initials: el.getAttribute("data-initials"),
          text: el.textContent,
        })),
    };
  }, chips);
}

for (const route of ["/", "/traders/?window=All"]) {
  test(`${route} is set in the export's type, colour and control tokens`, async ({
    page,
  }, testInfo) => {
    const desktop = testInfo.project.name === "desktop";
    await page.goto(route);
    await expect(
      page.locator(".page [data-row='resolved']").first(),
    ).toBeAttached({ timeout: 30_000 });
    await page.evaluate(() => document.fonts.ready);
    const found = await measure(page);
    await testInfo.attach("tokens", {
      body: JSON.stringify(found),
      contentType: "application/json",
    });
    expect(found.weight900, "the export never sets 900").toEqual([]);
    expect(
      [...new Set(found.heads)],
      "one head label style: 11.5px caps at 400",
    ).toEqual(desktop ? ["11.5px/400/uppercase"] : []);
    expect(found.under11, "no text under 11px outside chips").toEqual([]);
    if (route === "/")
      expect(
        found.heavy / found.textNodes,
        "regular weight is the default; 600 is for what carries a row",
      ).toBeLessThan(0.25);
    expect([...new Set(found.panels)], "panels on the line token").toEqual([
      line,
    ]);
    for (const mark of found.unavailable) {
      expect(mark.color, "an unavailable mark in the faint token").toBe(faint);
      expect(mark.weight).toBe("400");
      expect(
        mark.text,
        "empty in a cell, a quiet mark only on a stat card",
      ).toBe(mark.inStat ? "–" : "");
    }
    for (const control of found.segmented) {
      expect(
        control.height,
        desktop ? "a 32px segmented frame" : "phone segments at 44px",
      ).toBe(desktop ? 32 : 50);
      for (const height of control.buttons)
        expect(height).toBe(desktop ? 26 : 44);
      for (const font of control.font) expect(font).toBe("12px/600");
    }
    for (const button of found.buttons) {
      expect(button.height, desktop ? "38px buttons" : "44px buttons").toBe(
        desktop ? 38 : 44,
      );
      expect(button.fontSize).toBe("13px");
    }
    for (const color of found.colors)
      if (color !== "rgb(242, 242, 245)" && color !== "rgb(187, 244, 81)")
        expect(secondary, `${color} is a secondary text token`).toContain(
          color,
        );
    /* The suite serves no live feed, so the rail's rows are whatever the
       first paint left; any name it shows is set like the export's. */
    for (const name of found.rail) expect(name).toBe("12.5px/400");
    if (route === "/")
      expect(
        [...new Set(found.screenerSubscripts)],
        "price subscripts use the 11.5px UI-text floor",
      ).toEqual(desktop ? ["11.5px/400"] : []);
    expect(found.avatars.length).toBeGreaterThan(0);
    for (const avatar of found.avatars) {
      expect(avatar.initials).toMatch(/^[0-9A-F]{2}$/);
      expect(avatar.text, "the letters are decoration, not cell text").toBe("");
      expect(avatar.background, "a hue of its own, never the accent").not.toBe(
        "rgb(187, 244, 81)",
      );
    }
  });
}

test("screener cells use the compact line rhythm while prose keeps its reading rhythm", async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => {
    const state = { cls: 0 };
    Object.assign(window, { compactLineMeasurement: state });
    new PerformanceObserver((list) => {
      for (const raw of list.getEntries()) {
        const shift = raw as PerformanceEntry & {
          hadRecentInput: boolean;
          value: number;
        };
        if (!shift.hadRecentInput) state.cls += shift.value;
      }
    }).observe({ type: "layout-shift", buffered: true });
  });
  const desktop = testInfo.project.name === "desktop";
  await page.setViewportSize({
    width: desktop ? 1440 : 390,
    height: desktop ? 1000 : 844,
  });
  await page.goto("/");
  const layout = desktop ? ".desktop-pools" : ".mobile-pools";
  await expect(
    page.locator(`${layout} [data-row='resolved']`).first(),
  ).toBeVisible();
  const measured = await page.evaluate(async (layout) => {
    await document.fonts.ready;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    const shown = (element: Element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden"
      );
    };
    const row = document.querySelector(`${layout} [data-row='resolved']`)!;
    const token = row.querySelector(".token-cell")!;
    const lines = [
      token.querySelector("strong")!,
      token.querySelector("small")!,
    ];
    const tokenBox = token.getBoundingClientRect();
    const rowBox = row.getBoundingClientRect();
    const compact = [...row.querySelectorAll("*")]
      .filter(
        (element) =>
          shown(element) &&
          [...element.childNodes].some(
            (node) =>
              node.nodeType === Node.TEXT_NODE && node.textContent!.trim(),
          ) &&
          parseFloat(getComputedStyle(element).fontSize) <= 13 &&
          parseFloat(getComputedStyle(element).lineHeight) > 0,
      )
      .map((element) => {
        const style = getComputedStyle(element);
        return {
          text: element.textContent!.trim(),
          fontSize: parseFloat(style.fontSize),
          lineHeight: parseFloat(style.lineHeight),
        };
      });
    const prose = getComputedStyle(document.querySelector(".footer-credit")!);
    return {
      compact,
      prose: {
        fontSize: parseFloat(prose.fontSize),
        lineHeight: parseFloat(prose.lineHeight),
      },
      rowHeight: rowBox.height,
      lines: lines.map((line) => {
        const box = line.getBoundingClientRect();
        return {
          text: line.textContent!.trim(),
          top: box.top,
          bottom: box.bottom,
          insideToken:
            box.top >= tokenBox.top - 0.5 &&
            box.bottom <= tokenBox.bottom + 0.5,
          insideRow:
            box.top >= rowBox.top - 0.5 && box.bottom <= rowBox.bottom + 0.5,
          clipped: line.scrollHeight > line.clientHeight,
        };
      }),
      cls: (window as unknown as { compactLineMeasurement: { cls: number } })
        .compactLineMeasurement.cls,
    };
  }, layout);
  await testInfo.attach("compact-line-height", {
    body: JSON.stringify(measured),
    contentType: "application/json",
  });
  expect(
    measured.compact.length,
    "the row has compact UI text",
  ).toBeGreaterThan(0);
  for (const text of measured.compact)
    expect(
      text.lineHeight / text.fontSize,
      `${text.text} follows the compact 1.25 rhythm`,
    ).toBeCloseTo(1.25, 2);
  expect(
    measured.prose.lineHeight / measured.prose.fontSize,
    "prose keeps the 1.5 reading rhythm",
  ).toBeCloseTo(1.5, 2);
  expect(measured.rowHeight, "reserved row height is unchanged").toBe(
    desktop ? 62 : 104,
  );
  expect(measured.lines[1].top).toBeGreaterThanOrEqual(
    measured.lines[0].bottom - 0.5,
  );
  for (const line of measured.lines) {
    expect(line.insideToken, `${line.text} fits its two-line cell`).toBe(true);
    expect(line.insideRow, `${line.text} fits its row`).toBe(true);
    expect(line.clipped, `${line.text} is not vertically clipped`).toBe(false);
  }
  expect(measured.cls, "measured CLS after first paint").toBe(0);
});
