import { test, expect } from "@playwright/test";

const unfiltered =
  "/api/product/explore/?window=24h&view=all&offset=0&limit=25&q=&sort=launch&direction=desc";

test("typing a screener filter issues at most two explore requests and keeps the previous rows on show, dimmed, while it resolves", async ({
  page,
  request,
}) => {
  const payload = await (await request.get(unfiltered)).json();
  const queries: string[] = [],
    releases: Array<() => void> = [];
  await page.route("**/api/product/explore/?**", async (route) => {
    const params = new URL(route.request().url()).searchParams;
    if (params.get("limit") !== "25") return route.continue();
    const q = params.get("q") ?? "";
    queries.push(q);
    // Hold the filtered answer so the rows on screen can be read mid-flight.
    if (q)
      await new Promise<void>((resolve) => {
        releases.push(resolve);
      });
    await route
      .fulfill({
        json: q
          ? { ...payload, items: [], total: 0, nextOffset: null }
          : payload,
      })
      .catch(() => {
        /* A superseded request is aborted by the page; nothing to answer. */
      });
  });
  await page.goto("/");
  const rows = page.locator(".desktop-pools, .mobile-pools"),
    first = rows
      .getByText(payload.items[0].name, { exact: true })
      .filter({ visible: true });
  await expect(first).toBeVisible();
  const before = queries.length;

  const input = page.getByRole("textbox", { name: "Filter pools" });
  await input.click();
  await input.pressSequentially("foss", { delay: 80 });

  // The control itself never lags behind the typing.
  await expect(input).toHaveValue("foss");
  await expect(page).toHaveURL(/[?&]q=foss(&|$)/);
  await expect.poll(() => releases.length).toBeGreaterThan(0);
  const issued = queries.slice(before);
  expect(issued.length, `explore requests: ${issued.join(", ")}`).toBeLessThan(
    3,
  );
  expect(issued.at(-1)).toBe("foss");

  // The moment the debounced request is issued, the previous query's rows
  // keep filling the region, dimmed, rather than flashing to a skeleton: a
  // filter change is a genuine new server read (a different `q`), but there
  // is no reason to drop what is already on screen while it resolves.
  const visibleRows = rows.filter({ visible: true }).first();
  await expect(visibleRows).toHaveAttribute("aria-busy", "true");
  await expect(visibleRows).toHaveAttribute("data-stale-rows", "true");
  await expect(first).toBeVisible();
  await expect(visibleRows.locator('[data-row="skeleton"]')).toHaveCount(0);
  for (const release of releases) release();
  await expect(
    page.getByRole("heading", { name: "No pools match these filters" }),
  ).toBeVisible();
  await expect(visibleRows).toHaveAttribute("data-stale-rows", "false");
  await expect(first, "the filtered query truly has no matches").toHaveCount(
    0,
  );
});

test("Enter and blur commit the screener filter without waiting", async ({
  page,
}) => {
  const queries: string[] = [];
  await page.route("**/api/product/explore/?**", (route) => {
    const params = new URL(route.request().url()).searchParams;
    if (params.get("limit") === "25") queries.push(params.get("q") ?? "");
    return route.continue();
  });
  await page.goto("/");
  await expect(
    page.locator(".explore-page [data-row='resolved']").first(),
  ).toBeAttached();
  const input = page.getByRole("textbox", { name: "Filter pools" });
  await input.click();
  // Each budget is shorter than the debounce, so only a flush can have written
  // the URL by then.
  await input.pressSequentially("zz", { delay: 10 });
  await input.press("Enter");
  await expect(page).toHaveURL(/[?&]q=zz(&|$)/, { timeout: 150 });
  await input.pressSequentially("qq", { delay: 10 });
  await input.blur();
  await expect(page).toHaveURL(/[?&]q=zzqq(&|$)/, { timeout: 150 });
  await expect(input).toHaveValue("zzqq");
  await expect.poll(() => queries.at(-1)).toBe("zzqq");
  // A flush replaces the pending timer rather than adding a second request.
  await page.waitForTimeout(400);
  expect(queries.filter((q) => q === "zzqq")).toHaveLength(1);
});
