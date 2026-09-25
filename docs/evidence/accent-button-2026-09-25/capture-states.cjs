// Captures every primary .button consumer in rest/hover/active/focus-visible
// (and disabled where real) at 1440 and 390. Usage: node capture.cjs <port> <outdir>
const { chromium } = require(process.env.PW); // PW=<repo>/node_modules/@playwright/test
const fs = require("fs");
const path = require("path");

const port = process.argv[2];
const out = process.argv[3];
const base = `http://127.0.0.1:${port}`;
const wallet = "0x78cc2ff0a2127c1bbb96b99124fadc8c41f89388";
const pool =
  "0x90b4dfb7ac6ba0e311e20847a8a49b73cd47176f977a95a0d36a6b0cd62354ed";

const consumers = [
  {
    name: "screener-cta",
    url: "/",
    loc: (p) => p.locator(".page-heading .leaderboard-cta"),
  },
  {
    name: "wallet-copy-trade",
    url: `/wallet/${wallet}/`,
    loc: (p) =>
      p.locator("button.button:not(.secondary)", { hasText: "Copy trade" }),
  },
  {
    name: "pool-wallet-copy-trade",
    url: `/wallet/${wallet}/?pool=${pool}`,
    loc: (p) =>
      p.locator(".button:not(.secondary)", { hasText: "Copy trade" }).first(),
  },
  {
    name: "preview-dialog-action",
    url: `/wallet/${wallet}/?pool=${pool}`,
    setup: async (p) => {
      await p
        .locator(".button:not(.secondary)", { hasText: "Copy trade" })
        .first()
        .click();
    },
    loc: (p) => p.locator("dialog[open] a.button"),
  },
  {
    name: "preview-save-disabled",
    url: `/wallet/${wallet}/?pool=${pool}`,
    setup: async (p) => {
      await p.getByText("Edit profile").first().click();
    },
    loc: (p) => p.locator("dialog[open] button.button:disabled"),
    disabledOnly: true,
  },
  {
    name: "wallet-lookup",
    url: "/wallet/",
    loc: (p) => p.locator("button.button", { hasText: "Open wallet profile" }),
  },
  {
    name: "pool-trade",
    url: `/pool/${pool}/`,
    loc: (p) =>
      p.locator("a.button:not(.secondary)", { hasText: "Trade on Pools" }),
  },
  {
    name: "not-found",
    url: "/no-such-page/",
    loc: (p) => p.locator(".not-found .button"),
  },
  {
    name: "set-wallet-submit",
    url: "/traders/",
    setup: async (p) => {
      await p.getByRole("button", { name: "Set my wallet" }).click();
    },
    loc: (p) => p.locator(".wallet-set-dialog button[type=submit]"),
  },
  {
    name: "pnl-share",
    url: `/wallet/${wallet}/`,
    setup: async (p) => {
      await p.getByRole("button", { name: "Share PnL card" }).first().click();
      await p
        .locator("dialog[open] .button:not(.secondary):not(:disabled)", {
          hasText: "Share",
        })
        .waitFor({ timeout: 30000 });
    },
    loc: (p) =>
      p.locator("dialog[open] .button:not(.secondary)", { hasText: "Share" }),
  },
];

const states = [
  ["rest", []],
  ["hover", ["hover"]],
  ["active", ["hover", "active"]],
  ["focus-visible", ["focus", "focus-visible"]],
];

(async () => {
  const browser = await chromium.launch();
  const report = {};
  for (const [label, vp] of [
    ["1440", { width: 1440, height: 1000 }],
    ["390", { width: 390, height: 844 }],
  ]) {
    fs.mkdirSync(path.join(out, label), { recursive: true });
    const context = await browser.newContext({
      viewport: vp,
      deviceScaleFactor: 2,
    });
    for (const c of consumers) {
      const page = await context.newPage();
      try {
        await page.goto(base + c.url, { waitUntil: "load", timeout: 60000 });
        if (c.setup) await c.setup(page);
        const el = c.loc(page);
        await el.waitFor({ timeout: 30000 });
        await el.scrollIntoViewIfNeeded();
        await page.mouse.move(0, 0);
        await page.waitForTimeout(2500);
        await el.evaluate((n) => n.setAttribute("data-shot", "1"));
        const cdp = await page.context().newCDPSession(page);
        await cdp.send("DOM.enable");
        await cdp.send("CSS.enable");
        const { root } = await cdp.send("DOM.getDocument", { depth: 0 });
        const { nodeId } = await cdp.send("DOM.querySelector", {
          nodeId: root.nodeId,
          selector: "[data-shot]",
        });
        const list = c.disabledOnly ? [["disabled", []]] : states;
        for (const [state, forced] of list) {
          await cdp.send("CSS.forcePseudoState", {
            nodeId,
            forcedPseudoClasses: forced,
          });
          await page.waitForTimeout(150);
          const info = await el.evaluate((n) => {
            const s = getComputedStyle(n);
            const r = n.getBoundingClientRect();
            return {
              x: r.x,
              y: r.y,
              width: r.width,
              height: r.height,
              background: s.backgroundColor,
              color: s.color,
              border: s.border,
              borderRadius: s.borderRadius,
              boxShadow: s.boxShadow,
              outline: s.outline,
              outlineOffset: s.outlineOffset,
              fontWeight: s.fontWeight,
              fontSize: s.fontSize,
              padding: s.padding,
              opacity: s.opacity,
              text: n.textContent.trim(),
            };
          });
          (report[label] ??= {})[`${c.name}:${state}`] = info;
          const pad = 14;
          await page.screenshot({
            path: path.join(out, label, `${c.name}-${state}.png`),
            clip: {
              x: Math.max(0, info.x - pad),
              y: Math.max(0, info.y - pad),
              width: info.width + pad * 2,
              height: info.height + pad * 2,
            },
          });
        }
        await cdp.send("CSS.forcePseudoState", {
          nodeId,
          forcedPseudoClasses: [],
        });
      } catch (e) {
        console.error(`${label} ${c.name}: ${e.message.split("\n")[0]}`);
      }
      await page.close();
    }
    await context.close();
  }
  fs.writeFileSync(
    path.join(out, "report.json"),
    JSON.stringify(report, null, 2),
  );
  await browser.close();
})();
