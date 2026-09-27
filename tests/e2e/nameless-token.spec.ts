import { test, expect, type Page } from "@playwright/test";

/* A launch's name and symbol are whatever its contract returned: production's
   0x10382be9… names itself " " with symbol " ", which rendered an empty name
   line over a subline opening on "· 6h". Every explore read here (the
   screener's rows and the Just launched rail alike) serves its first row in
   that production shape and its second with an empty name and a real symbol;
   the third is left as served and is the height both must match. */

const token = (index: number) =>
  `.explore-page [data-row='resolved'][data-row-index='${index}']`;

async function serveNameless(page: Page) {
  await page.route("**/api/product/explore/?**", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    const [blank, unnamed] = body.items;
    if (blank) Object.assign(blank, { name: " ", symbol: " " });
    if (unnamed) Object.assign(unnamed, { name: "", symbol: "PEPE" });
    await route.fulfill({ response, json: body });
  });
}

const short = (address: string) =>
  `${address.slice(0, 6)}…${address.slice(-4)}`;

for (const view of ["", "?view=new"]) {
  test(`a nameless token reads as its symbol or address${view ? " in New" : ""}`, async ({
    page,
  }) => {
    await serveNameless(page);
    const tokens: string[] = [];
    page.on("response", async (response) => {
      if (!/\/api\/product\/explore\/\?/.test(response.url())) return;
      if (new URL(response.url()).searchParams.get("limit") === "6") return;
      const body = await response.json().catch(() => null);
      if (body?.items?.length) tokens.push(body.items[0].token);
    });
    await page.goto(`/${view}`);
    const rows = [0, 1, 2].map((index) =>
      page.locator(token(index)).filter({ visible: true }),
    );
    await expect(rows[2]).toBeVisible();
    // Ages land after hydration; every visible one must have resolved.
    await expect(
      page.locator("time[data-pending='true']").filter({ visible: true }),
    ).toHaveCount(0);

    const blank = await rows[0].locator(".token-cell").innerText();
    const unnamed = await rows[1].locator(".token-cell").innerText();
    const [label, subline = ""] = blank.split("\n").map((s) => s.trim());
    expect(label).toBe(short(tokens[0]!));
    const [unnamedLabel, unnamedSubline = ""] = unnamed
      .split("\n")
      .map((s) => s.trim());
    expect(unnamedLabel).toBe("PEPE");
    /* A measured row's subline opens on its age; a launch-only row (the New
       view's) carries its age on the launch line and leaves this one blank.
       Neither repeats the symbol that is already the label. */
    for (const line of [subline, unnamedSubline]) {
      expect(line, "the subline opens on the age, not a dot").toMatch(
        /^(\d+[smhdwy]\b.*)?$/,
      );
      expect(line).not.toMatch(/·\s*$|·\s*·|PEPE/);
    }

    const heights = await Promise.all(
      rows.map((row) =>
        row.evaluate((node) => node.getBoundingClientRect().height),
      ),
    );
    expect(heights[0], "a nameless row keeps a named row's height").toBe(
      heights[2],
    );
    expect(heights[1]).toBe(heights[2]);

    const rail = page
      .getByRole("region", { name: "Just launched" })
      .locator(".launch-card[href^='/pool'] .launch-card-label strong")
      .first();
    await expect(rail).not.toHaveText(/^\s*$/);
  });
}
