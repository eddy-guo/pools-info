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
    if (
      r.resourceType() === "image" &&
      !r.url().startsWith("http://127.0.0.1:3101/")
    )
      externalImages.push(r.url());
  });
  await page.goto("/");
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
