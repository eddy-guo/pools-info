import { test, expect, type Page } from "@playwright/test";
import chain from "../../data/snapshots/chain.json";

const [first, second, personal] = chain.markets;
const storageKey = "poolsinfo.watchlist.v1";
const rows = (page: Page) =>
  page
    .locator(".desktop-pools .token-cell, .mobile-pools .token-cell")
    .filter({ visible: true });
const savedIds = (page: Page) =>
  page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key) || "[]") as string[],
    storageKey,
  );
async function disableLive(page: Page) {
  await page.route("**/api/markets/", (route) =>
    route.fulfill({ status: 503, json: { error: "disabled" } }),
  );
}

test("copied watchlists open in a fresh browser and import only with an explicit merge", async ({
  page,
  context,
  browser,
}, testInfo) => {
  await disableLive(page);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.addInitScript(
    ({ firstId, secondId }) => {
      if (localStorage.getItem("pools:watchlist") === null)
        localStorage.setItem(
          "pools:watchlist",
          JSON.stringify([firstId.toUpperCase(), secondId, firstId]),
        );
    },
    { firstId: first.id, secondId: second.id },
  );
  const source = new URL("http://127.0.0.1:3101/");
  source.search = new URLSearchParams({
    view: "watchlist",
    window: "7d",
    sort: "launch",
    dir: "asc",
    q: first.token,
    offset: "25",
  }).toString();
  await page.goto(source.href);
  await page
    .getByRole("button", { name: "Copy watchlist link", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "Watchlist link copied." }),
  ).toBeVisible();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  const link = new URL(copied);
  expect(link.searchParams.get("watchlist")).toBe(
    [first.id, second.id].join(",").toLowerCase(),
  );
  expect(
    Object.fromEntries(
      ["window", "sort", "dir", "q"].map((key) => [
        key,
        link.searchParams.get(key),
      ]),
    ),
  ).toEqual({ window: "7d", sort: "launch", dir: "asc", q: first.token });
  expect(link.searchParams.has("offset")).toBe(false);
  expect(copied.length).toBeLessThanOrEqual(4096);

  const recipientContext = await browser.newContext({
    viewport: page.viewportSize(),
    isMobile: testInfo.project.name === "mobile",
    hasTouch: testInfo.project.name === "mobile",
  });
  try {
    const recipient = await recipientContext.newPage();
    await disableLive(recipient);
    await recipient.goto(copied);
    await expect(
      recipient.getByRole("region", { name: "Shared watchlist", exact: true }),
    ).toBeVisible();
    await expect(rows(recipient)).toHaveCount(1);
    await expect(rows(recipient)).toContainText(first.name);
    expect(
      await recipient.evaluate(() => [
        localStorage.getItem("poolsinfo.watchlist.v1"),
        localStorage.getItem("pools:watchlist"),
      ]),
    ).toEqual([null, null]);
    await expect(
      recipient.getByRole("combobox", { name: "Sort all pools", exact: true }),
    ).toHaveValue("launch");
    await recipient
      .getByRole("textbox", { name: "Filter pools", exact: true })
      .fill("");
    await expect(rows(recipient)).toHaveCount(2);

    // A second tab adds a personal star while the shared view remains open.
    const otherTab = await recipientContext.newPage();
    await disableLive(otherTab);
    await otherTab.goto(`http://127.0.0.1:3101/?q=${personal.token}`);
    await otherTab
      .getByRole("button", { name: "Add to watchlist", exact: true })
      .filter({ visible: true })
      .click();
    await expect.poll(() => savedIds(otherTab)).toEqual([personal.id]);
    await expect(rows(recipient)).toHaveCount(2);
    await recipient
      .getByRole("button", { name: "Save to my watchlist", exact: true })
      .click();
    await expect(
      recipient.getByRole("status").filter({ hasText: "Shared pools saved" }),
    ).toBeVisible();
    await expect
      .poll(async () => (await savedIds(recipient)).sort())
      .toEqual([first.id, second.id, personal.id].sort());
    await otherTab
      .getByRole("button", { name: "Watchlist", exact: true })
      .click();
    await otherTab
      .getByRole("textbox", { name: "Filter pools", exact: true })
      .fill("");
    await expect(rows(otherTab)).toHaveCount(3);
    await recipient
      .getByRole("button", { name: "My watchlist", exact: true })
      .click();
    await expect(recipient).not.toHaveURL(/watchlist=/);
    await expect(rows(recipient)).toHaveCount(3);
    await recipient.reload();
    await expect(rows(recipient)).toHaveCount(3);
    expect(
      await recipient.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  } finally {
    await recipientContext.close();
  }
});

test("invalid shared links remain empty without falling back to personal stars or forwarding unbounded IDs", async ({
  page,
}) => {
  await disableLive(page);
  await page.addInitScript(
    ({ key, id }) => localStorage.setItem(key, JSON.stringify([id])),
    { key: storageKey, id: personal.id },
  );
  const requests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      url.pathname === "/api/product/explore" &&
      url.searchParams.get("view") === "watchlist"
    )
      requests.push(url.searchParams.get("ids") ?? "missing");
  });
  const tooMany = Array.from(
    { length: 51 },
    (_, i) => `0x${i.toString(16).padStart(64, "0")}`,
  ).join(",");
  for (const [query, message] of [
    ["watchlist=", "This shared watchlist is empty."],
    ["watchlist=invalid", "invalid pool ID"],
    [`watchlist=${first.id}&watchlist=${second.id}`, "more than one watchlist"],
    [`watchlist=${tooMany}`, "up to 50 pools"],
  ]) {
    await page.goto(`/?view=watchlist&${query}`);
    await expect(
      page.getByRole("alert").filter({ hasText: message }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", {
        name: "This shared watchlist cannot be displayed",
      }),
    ).toBeVisible();
    await expect(rows(page)).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Copy watchlist link", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Save to my watchlist", exact: true }),
    ).toBeDisabled();
    expect(await savedIds(page)).toEqual([personal.id]);
  }
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.every((ids) => ids === "")).toBe(true);
});

test("large personal lists stay saved while reads and share links respect their limits", async ({
  page,
}) => {
  await disableLive(page);
  const ids = [
    first.id,
    ...Array.from(
      { length: 200 },
      (_, i) => `0x${i.toString(16).padStart(64, "0")}`,
    ),
  ];
  await page.addInitScript(
    ({ key, ids }) => localStorage.setItem(key, JSON.stringify(ids)),
    { key: storageKey, ids },
  );
  const watchlistRequest = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return (
      url.pathname === "/api/product/explore" &&
      url.searchParams.get("view") === "watchlist" &&
      !!url.searchParams.get("ids")
    );
  });
  await page.goto("/?view=watchlist");
  const requested = new URL((await watchlistRequest).url()).searchParams
    .get("ids")!
    .split(",");
  expect(requested).toHaveLength(200);
  await expect(
    page.getByText("Showing the first 200 saved pools.", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Copy watchlist link", exact: true }),
  ).toBeDisabled();
  expect(await savedIds(page)).toEqual(ids);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("clipboard failure exposes a selectable watchlist link and accessible feedback", async ({
  page,
}) => {
  await disableLive(page);
  await page.addInitScript(
    ({ key, id }) => {
      localStorage.setItem(key, JSON.stringify([id]));
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async () => {
            throw new Error("Clipboard denied");
          },
        },
      });
    },
    { key: storageKey, id: first.id },
  );
  await page.goto("/?view=watchlist");
  await page
    .getByRole("button", { name: "Copy watchlist link", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "Clipboard unavailable" }),
  ).toBeVisible();
  const input = page.getByRole("textbox", {
    name: "Watchlist share link",
    exact: true,
  });
  await expect(input).toBeVisible();
  expect(new URL(await input.inputValue()).searchParams.get("watchlist")).toBe(
    first.id,
  );
  await input.focus();
  expect(
    await input.evaluate(
      (node: HTMLInputElement) => node.selectionEnd! - node.selectionStart!,
    ),
  ).toBe((await input.inputValue()).length);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
