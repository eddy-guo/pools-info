import { test, expect } from "@playwright/test";
import { preloadedProduct } from "../../apps/web/src/lib/product-server";
import type { AnalyticsExploreResponse } from "@pools/core";

// Valid tiny raster bytes for the browser boundary. Server tests separately
// exercise DNS pinning, MIME/body checks and actual sharp re-encoding.
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=",
  "base64",
);

test("token images load lazily through the local endpoint and retain generated fallback on failure", async ({
  page,
  baseURL,
}) => {
  const imageRequests = new Set<string>();
  let failImages = false;
  await page.route("**/api/markets/", (route) =>
    route.fulfill({ status: 503, json: { error: "disabled" } }),
  );
  await page.route("**/api/product/explore**", async (route) => {
    const query = new URL(route.request().url()).searchParams;
    const data = structuredClone(
      await preloadedProduct("explore", query),
    ) as AnalyticsExploreResponse;
    for (const pool of data.items)
      pool.imageUrl = "https://pools.trade/a-real-metadata-url.png";
    await route.fulfill({
      json: { ...data, delivery: { source: "preloaded", notice: null } },
    });
  });
  await page.route("**/api/token-image/**", async (route) => {
    imageRequests.add(route.request().url());
    await route.fulfill(
      failImages
        ? { status: 404, body: "" }
        : { status: 200, contentType: "image/png", body: png },
    );
  });
  const externalImages: string[] = [];
  page.on("request", (r) => {
    if (r.resourceType() === "image" && !r.url().startsWith(`${baseURL}/`))
      externalImages.push(r.url());
  });
  // The launches view still fills a page of rows; the default volume sort
  // only lists pools with market evidence.
  await page.goto("/?view=new");
  const icons = page.locator("[data-pool-image]").filter({ visible: true });
  await expect(icons.first()).toHaveAttribute("data-image-state", "loaded");
  const image = icons.first().locator("img");
  await expect(image).toHaveAttribute(
    "src",
    /^\/api\/token-image\/0x[0-9a-f]{64}\/$/,
  );
  await expect(image).toHaveAttribute("loading", "lazy");
  expect(
    await image.evaluate((node: HTMLImageElement) => node.naturalWidth),
  ).toBe(1);
  expect(externalImages).toEqual([]);
  // A page has many catalog rows; only rows intersecting the viewport margin
  // may create an image element, rather than mounting requests for all history.
  const deferred = await page.locator("[data-pool-image]").evaluateAll(
    (nodes) =>
      nodes.filter((node) => {
        const rect = node.getBoundingClientRect();
        return (
          rect.top > window.innerHeight + 100 && !node.querySelector("img")
        );
      }).length,
  );
  expect(deferred).toBeGreaterThan(0);
  expect(imageRequests.size).toBeLessThan(25);

  failImages = true;
  await page.reload();
  await expect(icons.first()).toHaveAttribute("data-image-state", "failed");
  await expect(icons.first().locator("img")).toHaveCount(0);
  await expect(icons.first().locator(".avatar svg")).toBeVisible();
  expect(externalImages).toEqual([]);
});

test("image endpoint rejects arbitrary URL parameters and unavailable pools without leaking configuration", async ({
  request,
}) => {
  const id = `0x${"a".repeat(64)}`;
  const invalid = await request.get(
    `/api/token-image/${id}/?url=http://127.0.0.1/`,
  );
  expect(invalid.status()).toBe(400);
  expect(await invalid.text()).toBe("");
  const absent = await request.get(`/api/token-image/${id}/`);
  expect(absent.status()).toBe(404);
  expect(await absent.text()).toBe("");
  expect(absent.headers()["x-content-type-options"]).toBe("nosniff");
});

test("token images recover from temporary capacity errors with bounded retries", async ({
  page,
  baseURL,
}, testInfo) => {
  await page.clock.install();
  const attempts = new Map<string, number>();
  let unavailable = false;
  await page.route("**/api/markets/", (route) =>
    route.fulfill({ status: 503, json: { error: "disabled" } }),
  );
  await page.route("**/api/product/explore**", async (route) => {
    const data = structuredClone(
      await preloadedProduct(
        "explore",
        new URL(route.request().url()).searchParams,
      ),
    ) as AnalyticsExploreResponse;
    for (const pool of data.items)
      pool.imageUrl = "https://pools.trade/a-real-metadata-url.png";
    await route.fulfill({
      json: { ...data, delivery: { source: "preloaded", notice: null } },
    });
  });
  await page.route("**/api/token-image/**", async (route) => {
    const url = route.request().url();
    const attempt = (attempts.get(url) ?? 0) + 1;
    attempts.set(url, attempt);
    await route.fulfill(
      unavailable || attempt === 1
        ? {
            status: unavailable ? 404 : 503,
            headers: { "Cache-Control": "no-store", "Retry-After": "5" },
            body: "",
          }
        : { status: 200, contentType: "image/png", body: png },
    );
  });
  // Keep rail/table identities distinct so this measures one image instance's retry budget.
  await page.goto("/?sort=volume");
  const icons = page.locator("[data-pool-image]").filter({ visible: true });
  const icon = icons.first();
  await expect(icon).toHaveAttribute("data-image-state", "failed");
  await expect(icon.locator(".avatar svg")).toBeVisible();
  const id = await icon.getAttribute("data-pool-image");
  const imageUrl = `${baseURL}/api/token-image/${id}/`;
  await page.clock.fastForward(5000);
  await expect(icon).toHaveAttribute("data-image-state", "loaded", {
    timeout: 2000,
  });
  expect(attempts.get(imageUrl)).toBe(2);
  await expect(icon.locator("img")).toHaveAttribute("loading", "lazy");
  if (testInfo.project.name === "desktop") {
    const row = page.locator(".desktop-pools tbody tr").first();
    const rowIcon = row.locator("[data-pool-image]");
    await expect(rowIcon).toHaveAttribute("data-image-state", "loaded");
    expect(
      await rowIcon.evaluate((el) => el.getBoundingClientRect().width),
    ).toBe(30);
    expect(await row.evaluate((el) => el.getBoundingClientRect().height)).toBe(
      62,
    );
  }

  unavailable = true;
  attempts.clear();
  await page.reload();
  await expect(icon).toHaveAttribute("data-image-state", "failed");
  await page.clock.fastForward(5000);
  await expect.poll(() => attempts.get(imageUrl)).toBe(2);
  await expect(icon).toHaveAttribute("data-image-state", "failed");
  await page.clock.fastForward(10000);
  await expect.poll(() => attempts.get(imageUrl)).toBe(3);
  await expect(icon).toHaveAttribute("data-image-state", "failed");
  await page.clock.fastForward(60000);
  expect(attempts.get(imageUrl)).toBe(3);
  await expect(icon.locator(".avatar svg")).toBeVisible();
  await expect(icon.locator("img")).toHaveCount(0);

  attempts.clear();
  await page.reload();
  await expect(icon).toHaveAttribute("data-image-state", "failed");
  // Client navigation unmounts the row while its retry timer is still pending.
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("link", { name: "Creators" })
    .click();
  await expect(page).toHaveURL(/\/creators\/$/);
  await expect(page.locator("[data-pool-image]")).toHaveCount(0);
  const attemptsBeforeUnmount = attempts.get(imageUrl);
  await page.clock.fastForward(20000);
  expect(attempts.get(imageUrl)).toBe(attemptsBeforeUnmount);
});
