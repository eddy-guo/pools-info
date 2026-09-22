import { expect, test, type Locator, type Page } from "@playwright/test";

const colors = {
  accent: "rgb(187, 244, 81)",
  accentDeep: "rgb(25, 46, 3)",
  panelRaised: "rgb(16, 16, 20)",
  panelHover: "rgb(18, 18, 22)",
  surface5: "rgb(28, 28, 34)",
  surface6: "rgb(30, 30, 37)",
  line: "rgb(34, 34, 42)",
  lineActive: "rgb(42, 42, 51)",
  lineHover: "rgb(51, 51, 61)",
  text: "rgb(242, 242, 245)",
  text2: "rgb(180, 180, 190)",
} as const;

type Visual = Awaited<ReturnType<typeof visual>>;

function visual(control: Locator) {
  return control.evaluate((element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const icon = element.querySelector("svg");
    const iconRect = icon?.getBoundingClientRect();
    const iconStyle = icon ? getComputedStyle(icon) : null;
    return {
      background: style.backgroundColor,
      border: style.borderColor,
      borderRadius: style.borderRadius,
      borderWidth: style.borderWidth,
      boxShadow: style.boxShadow,
      color: style.color,
      cursor: style.cursor,
      filter: style.filter,
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      gap: style.gap,
      lineHeight: style.lineHeight,
      opacity: style.opacity,
      outlineColor: style.outlineColor,
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      padding: style.padding,
      icon:
        iconRect && iconStyle
          ? {
              height: iconRect.height,
              strokeWidth: iconStyle.strokeWidth,
              width: iconRect.width,
            }
          : null,
      rect: {
        height: rect.height,
        width: rect.width,
        x: rect.x + scrollX,
        y: rect.y + scrollY,
      },
    };
  });
}

function channels(color: string) {
  const match = color.match(/rgba?\((\d+), (\d+), (\d+)/);
  if (!match) throw new Error(`Expected an rgb colour, got ${color}`);
  return match.slice(1).map(Number);
}

function contrast(foreground: string, background: string) {
  const luminance = (color: string) => {
    const linear = channels(color).map((value) => {
      const channel = value / 255;
      return channel <= 0.04045
        ? channel / 12.92
        : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  };
  const first = luminance(foreground);
  const second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function expectGeometry(state: Visual, rest: Visual) {
  expect(
    {
      borderWidth: state.borderWidth,
      fontWeight: state.fontWeight,
      height: state.rect.height,
      width: state.rect.width,
    },
    "interaction states do not move or resize the control",
  ).toEqual({
    borderWidth: rest.borderWidth,
    fontWeight: rest.fontWeight,
    height: rest.rect.height,
    width: rest.rect.width,
  });
}

async function pressed(page: Page, control: Locator) {
  await control.hover();
  const box = await control.boundingBox();
  if (!box) throw new Error("The control has no box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  const state = await visual(control);
  await page.mouse.move(0, 0);
  await page.mouse.up();
  return state;
}

async function focusVisible(page: Page, control: Locator) {
  await control.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(control).toBeFocused();
  return visual(control);
}

function expectFocus(state: Visual, rest: Visual) {
  expectGeometry(state, rest);
  expect(state.outlineColor).toBe(colors.accent);
  expect(state.outlineStyle).toBe("solid");
  expect(state.outlineWidth).toBe("2px");
}

function expectTextContrast(state: Visual) {
  expect(
    contrast(state.color, state.background),
    `${state.color} on ${state.background}`,
  ).toBeGreaterThanOrEqual(4.5);
}

function primaryActionSignature(state: Visual) {
  return {
    background: state.background,
    border: state.border,
    borderRadius: state.borderRadius,
    borderWidth: state.borderWidth,
    boxShadow: state.boxShadow,
    color: state.color,
    filter: state.filter,
    fontFamily: state.fontFamily,
    fontSize: state.fontSize,
    fontWeight: state.fontWeight,
    gap: state.gap,
    height: state.rect.height,
    icon: state.icon,
    lineHeight: state.lineHeight,
    outlineColor: state.outlineColor,
    outlineStyle: state.outlineStyle,
    outlineWidth: state.outlineWidth,
    padding: state.padding,
  };
}

test("primary, secondary and ghost controls share deliberate interaction states", async ({
  page,
}) => {
  await page.goto("/wallet/");
  await page.evaluate(() => document.fonts.ready);

  const primary = page.getByRole("button", { name: "Open wallet profile" });
  const primaryRest = await visual(primary);
  expect(primaryRest).toMatchObject({
    background: colors.accent,
    borderWidth: "1px",
    color: colors.accentDeep,
    filter: "none",
    fontWeight: "600",
  });
  expectTextContrast(primaryRest);
  await primary.hover();
  const primaryHover = await visual(primary);
  expectGeometry(primaryHover, primaryRest);
  expect(primaryHover).toMatchObject({
    background: colors.accent,
    color: colors.accentDeep,
    filter: "none",
  });
  expect(primaryHover.boxShadow).toContain(colors.accentDeep);
  expectTextContrast(primaryHover);
  const primaryPressed = await pressed(page, primary);
  expectGeometry(primaryPressed, primaryRest);
  expect(primaryPressed).toMatchObject({
    background: colors.accentDeep,
    color: colors.accent,
    filter: "none",
  });
  expectTextContrast(primaryPressed);
  expectFocus(await focusVisible(page, primary), primaryRest);

  await primary.evaluate((element) => {
    (element as HTMLButtonElement).disabled = true;
  });
  await primary.hover();
  const primaryDisabled = await visual(primary);
  expectGeometry(primaryDisabled, primaryRest);
  expect(primaryDisabled).toMatchObject({
    background: colors.accent,
    cursor: "not-allowed",
    opacity: "0.35",
  });
  expect(primaryDisabled.boxShadow).toBe("none");

  const secondary = page
    .locator(".personal-rank .button.secondary")
    .filter({ hasText: "Connect wallet" });
  const secondaryRest = await visual(secondary);
  expect(secondaryRest).toMatchObject({
    background: colors.panelRaised,
    border: colors.line,
    borderWidth: "1px",
    color: colors.text,
    filter: "none",
    fontWeight: "500",
  });
  expectTextContrast(secondaryRest);
  await secondary.hover();
  const secondaryHover = await visual(secondary);
  expectGeometry(secondaryHover, secondaryRest);
  expect(secondaryHover).toMatchObject({
    background: colors.panelHover,
    border: colors.lineHover,
    color: colors.text,
    filter: "none",
  });
  expectTextContrast(secondaryHover);
  const secondaryPressed = await pressed(page, secondary);
  expectGeometry(secondaryPressed, secondaryRest);
  expect(secondaryPressed).toMatchObject({
    background: colors.surface6,
    border: colors.lineActive,
  });
  expectFocus(await focusVisible(page, secondary), secondaryRest);

  const ghost = page.getByRole("button", { name: "Set my wallet" });
  const ghostRest = await visual(ghost);
  expect(ghostRest).toMatchObject({
    background: colors.panelRaised,
    border: colors.line,
    borderWidth: "1px",
    color: colors.accent,
    fontWeight: "600",
  });
  expectTextContrast(ghostRest);
  await ghost.hover();
  const ghostHover = await visual(ghost);
  expectGeometry(ghostHover, ghostRest);
  expect(ghostHover).toMatchObject({
    background: colors.panelHover,
    border: colors.lineHover,
    color: colors.accent,
  });
  expectTextContrast(ghostHover);
  const ghostPressed = await pressed(page, ghost);
  expectGeometry(ghostPressed, ghostRest);
  expect(ghostPressed).toMatchObject({
    background: colors.surface5,
    border: colors.lineActive,
  });
  expectFocus(await focusVisible(page, ghost), ghostRest);
});

test("accent CTA, tabs and segmented controls keep hierarchy across states", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(() => document.fonts.ready);

  const cta = page.getByRole("link", { name: "Trader leaderboard" });
  const ctaRest = await visual(cta);
  expect(ctaRest).toMatchObject({
    background: colors.accent,
    color: colors.accentDeep,
    filter: "none",
    fontWeight: "600",
  });
  await cta.hover();
  const ctaHover = await visual(cta);
  expectGeometry(ctaHover, ctaRest);
  expect(ctaHover.boxShadow).toContain(colors.accentDeep);
  expectTextContrast(ctaHover);
  const ctaPressed = await pressed(page, cta);
  expectGeometry(ctaPressed, ctaRest);
  expect(ctaPressed).toMatchObject({
    background: colors.accentDeep,
    color: colors.accent,
  });
  expectTextContrast(ctaPressed);
  expectFocus(await focusVisible(page, cta), ctaRest);

  const tabs = page.locator(".table-tabs");
  const selectedTab = tabs.getByRole("button", { name: "All", exact: true });
  const selectedStyle = await visual(selectedTab);
  expect(selectedStyle).toMatchObject({
    background: colors.surface6,
    color: colors.text,
  });
  expectTextContrast(selectedStyle);

  const tab = tabs.getByRole("button", { name: "Gainers" });
  const tabRest = await visual(tab);
  await tab.hover();
  const tabHover = await visual(tab);
  expectGeometry(tabHover, tabRest);
  expect(tabHover).toMatchObject({
    background: colors.panelHover,
    color: colors.text2,
  });
  expectTextContrast(tabHover);
  const tabPressed = await pressed(page, tab);
  expectGeometry(tabPressed, tabRest);
  expect(tabPressed).toMatchObject({
    background: colors.surface6,
    color: colors.text,
  });
  expectFocus(await focusVisible(page, tab), tabRest);

  const segment = page
    .locator(".unit-toggle")
    .getByRole("button", { name: "USD" });
  const segmentRest = await visual(segment);
  await segment.hover();
  const segmentHover = await visual(segment);
  expectGeometry(segmentHover, segmentRest);
  expect(segmentHover).toMatchObject({
    background: colors.panelHover,
    color: colors.text2,
  });
  expectTextContrast(segmentHover);
  const segmentPressed = await pressed(page, segment);
  expectGeometry(segmentPressed, segmentRest);
  expect(segmentPressed).toMatchObject({
    background: colors.surface5,
    color: colors.text,
  });
  expectFocus(await focusVisible(page, segment), segmentRest);

  const selectedSegment = page
    .locator(".unit-toggle")
    .getByRole("button", { name: "ETH" });
  const selectedSegmentStyle = await visual(selectedSegment);
  expect(selectedSegmentStyle).toMatchObject({
    background: colors.surface6,
    color: colors.text,
  });
  expectTextContrast(selectedSegmentStyle);
});

for (const width of [1440, 390]) {
  test(`Trader leaderboard and Copy trade are one primary action at ${width}px`, async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile, "one project measures both exact viewport widths");
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });

    await page.goto("/");
    await page.evaluate(() => document.fonts.ready);
    const leaderboard = page.getByRole("link", {
      name: "Trader leaderboard",
      exact: true,
    });
    await expect(leaderboard.locator("svg")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    const leaderboardRest = await visual(leaderboard);
    await leaderboard.hover();
    const leaderboardHover = await visual(leaderboard);
    const leaderboardActive = await pressed(page, leaderboard);
    const leaderboardFocus = await focusVisible(page, leaderboard);

    await page.goto(
      "/wallet/0x474583e46d2ea052fb5690bdebdb41d6cf1ebce1/?window=All",
    );
    await page.evaluate(() => document.fonts.ready);
    const copy = page.getByRole("button", { name: "Copy trade", exact: true });
    await expect(copy.locator("svg")).toHaveAttribute("aria-hidden", "true");
    const copyRest = await visual(copy);
    await copy.hover();
    const copyHover = await visual(copy);
    const copyActive = await pressed(page, copy);
    const copyFocus = await focusVisible(page, copy);

    expect(primaryActionSignature(copyRest), "rest").toEqual(
      primaryActionSignature(leaderboardRest),
    );
    expect(primaryActionSignature(copyHover), "hover").toEqual(
      primaryActionSignature(leaderboardHover),
    );
    expect(primaryActionSignature(copyActive), "active").toEqual(
      primaryActionSignature(leaderboardActive),
    );
    expect(primaryActionSignature(copyFocus), "focus-visible").toEqual(
      primaryActionSignature(leaderboardFocus),
    );
    expect(copyRest.rect.height).toBe(width === 390 ? 44 : 38);
    expect(copyRest.icon).toEqual({
      height: 15,
      strokeWidth: "2px",
      width: 15,
    });

    await copy.focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("dialog", { name: "Copy trading" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");

    await page.goto("/");
    const keyboardLeaderboard = page.getByRole("link", {
      name: "Trader leaderboard",
      exact: true,
    });
    await keyboardLeaderboard.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/traders\/$/);
  });
}

test("wallet and traders buttons use only shared control families", async ({
  page,
}) => {
  for (const url of [
    "/wallet/0x474583e46d2ea052fb5690bdebdb41d6cf1ebce1/?window=All",
    "/traders/?window=All&limit=5",
  ]) {
    await page.goto(url);
    await expect(page.locator('[data-pending="true"]:visible')).toHaveCount(0, {
      timeout: 20_000,
    });
    const oneOffs = await page
      .locator("main button:visible")
      .evaluateAll((buttons) =>
        buttons
          .filter(
            (button) =>
              !button.matches(".button, .icon-button, .text-button") &&
              !button.closest(".segmented, .table-tabs"),
          )
          .map((button) => ({
            className: button.className,
            label: button.getAttribute("aria-label") ?? button.textContent,
          })),
      );
    expect(oneOffs, url).toEqual([]);
  }
});

test("copy, explorer and star icon buttons keep geometry and visible states", async ({
  page,
  isMobile,
}) => {
  await page.goto(isMobile ? "/?view=new" : "/");
  await expect(page.locator("[data-row='resolved']").first()).toBeAttached({
    timeout: 30_000,
  });
  await page.evaluate(() => document.fonts.ready);

  const icons = [
    page.locator('button[aria-label="Copy address"]:visible').first(),
    page.locator('a[aria-label="Open address on explorer"]:visible').first(),
    page.locator('button[aria-label="Add to watchlist"]:visible').first(),
  ];

  for (const icon of icons) {
    await expect(icon).toBeVisible();
    const rest = await visual(icon);
    await icon.hover();
    const hover = await visual(icon);
    expectGeometry(hover, rest);
    expect(hover).toMatchObject({
      background: colors.surface6,
      color: colors.text,
    });
    const active = await pressed(page, icon);
    expectGeometry(active, rest);
    expect(active).toMatchObject({
      background: colors.surface5,
      color: colors.text,
    });
    expectFocus(await focusVisible(page, icon), rest);
  }

  const star = icons[2];
  const starRest = await visual(star);
  expect(starRest.rect.height).toBeGreaterThanOrEqual(isMobile ? 44 : 32);
  await star.evaluate((element) => element.classList.add("active"));
  expect((await visual(star)).color).toBe(colors.accent);
  await star.evaluate((element) => {
    (element as HTMLButtonElement).disabled = true;
  });
  await star.hover();
  const disabled = await visual(star);
  expectGeometry(disabled, starRest);
  expect(disabled).toMatchObject({
    cursor: "not-allowed",
    opacity: "0.35",
  });
  expect(disabled.background).toBe("rgba(0, 0, 0, 0)");
});
