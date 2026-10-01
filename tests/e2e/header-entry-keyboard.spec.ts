import { expect, test, type Page } from "@playwright/test";
import axe from "axe-core";
import chain from "../../data/snapshots/chain.json";

/**
 * The header's entry to the You page and the Set my wallet dialog the You
 * page opens, from the keyboard (accessibility pass 2026-09-29, cluster F5).
 * The entry is one link, reached by Tab, opened by Enter, named with what is
 * saved and ringed in the site's focus colour; the dialog opens on its
 * address field and hands focus back when it closes, to the button that
 * opened it or, once a wallet is marked and that button is gone, to the
 * marked row's Portfolio link.
 */

const wallet = "0x474583e46d2ea052fb5690bdebdb41d6cf1ebce1";
const widths = [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
];

async function tabTo(page: Page, selector: string) {
  for (let stops = 0; stops < 40; stops++) {
    await page.keyboard.press("Tab");
    if (
      await page.evaluate(
        (selector) => document.activeElement?.matches(selector) ?? false,
        selector,
      )
    )
      return;
  }
  throw new Error(`Tab never reached ${selector}`);
}

async function headerViolations(page: Page) {
  await page.addScriptTag({ content: axe.source });
  return page.evaluate(async () => {
    const result = await (
      window as typeof window & { axe: typeof axe }
    ).axe.run(".site-header");
    return result.violations.map(({ id, nodes }) => ({
      id,
      targets: nodes.map(({ target }) => target),
    }));
  });
}

test.describe("the header entry and the set-wallet dialog from the keyboard", () => {
  test.skip(({ isMobile }) => isMobile, "each test sets both widths itself");

  for (const size of widths) {
    for (const marked of [false, true]) {
      test(`at ${size.width}, Tab reaches the ${marked ? "marked" : "unmarked"} entry as one ringed link and Enter opens the You page`, async ({
        page,
      }) => {
        await page.setViewportSize(size);
        if (marked)
          await page.addInitScript(
            ({ wallet, pool }) => {
              localStorage.setItem("poolsinfo.my-wallet.v1", wallet);
              localStorage.setItem(
                "poolsinfo.watchlist.v1",
                JSON.stringify([pool]),
              );
            },
            { wallet, pool: chain.markets[1].id },
          );
        await page.goto("/");
        const entry = page.locator(".header-actions .connect-button");
        await expect(entry).toHaveAccessibleName(
          marked ? "You: 1 watched, 0 followed" : "You: nothing saved yet",
        );
        /* One focusable control in the slot, and it is the link itself. */
        expect(
          await page
            .locator(".wallet-profile-entry")
            .evaluate((slot) =>
              [
                ...slot.querySelectorAll(
                  "a[href], button, [tabindex], [role='button'], [role='menu']",
                ),
              ].map((node) => node.tagName),
            ),
        ).toEqual(["A"]);

        await tabTo(page, ".header-actions .connect-button");
        await expect(entry).toBeFocused();
        const ring = await entry.evaluate((link) => {
          const style = getComputedStyle(link);
          return {
            style: style.outlineStyle,
            width: style.outlineWidth,
            color: style.outlineColor,
            token: getComputedStyle(document.documentElement)
              .getPropertyValue("--control-focus-ring")
              .trim(),
          };
        });
        expect(ring.style).toBe("solid");
        expect(ring.width).toBe("2px");
        expect(ring.token).not.toBe("");
        const swatch = await page.evaluate((token) => {
          const probe = document.createElement("i");
          probe.style.color = token;
          document.body.append(probe);
          const color = getComputedStyle(probe).color;
          probe.remove();
          return color;
        }, ring.token);
        expect(ring.color).toBe(swatch);
        expect(await headerViolations(page)).toEqual([]);

        await page.keyboard.press("Enter");
        await page.waitForURL("**/you/");
        await expect(entry).toHaveAttribute("aria-current", "page");
      });
    }

    test(`at ${size.width}, the set-wallet dialog opens on its field and returns focus on every close`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      await page.goto("/you/");
      const open = page.getByRole("button", { name: "Set my wallet" });
      const dialog = page.locator("dialog.wallet-set-dialog");
      const field = page.locator("#wallet-set-address");

      await open.focus();
      await page.keyboard.press("Enter");
      await expect(dialog).toHaveAttribute("open", "");
      await expect(field).toBeFocused();
      await page.getByRole("button", { name: "Close" }).click();
      await expect(dialog).toHaveCount(0);
      await expect(open).toBeFocused();

      await page.keyboard.press("Enter");
      await expect(field).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(open).toBeFocused();

      await page.keyboard.press("Enter");
      await expect(field).toBeFocused();
      /* The backdrop is the dialog box itself, outside its content. */
      await page.mouse.click(5, 5);
      await expect(dialog).toHaveCount(0);
      await expect(open).toBeFocused();

      await page.keyboard.press("Enter");
      await field.fill(wallet);
      await page.keyboard.press("Enter");
      await expect(dialog).toHaveCount(0);
      await expect(page.locator(".you-identity .my-rank-link")).toBeFocused();
    });
  }
});
