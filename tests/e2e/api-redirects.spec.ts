import { test, expect } from "@playwright/test";
const wallet = "0x474583e46d2ea052fb5690bdebdb41d6cf1ebce1";
// Each route with the saved-data endpoint it must reach on its own.
const routes = [
  { path: "/", endpoint: "/api/product/explore/" },
  { path: "/traders/", endpoint: "/api/product/leaderboard/" },
  { path: `/wallet/${wallet}/`, endpoint: `/api/product/wallets/${wallet}/` },
  { path: "/creators/", endpoint: "/api/product/creators/" },
];

test("saved-data requests reach the API without a trailing-slash redirect", async ({
  page,
}) => {
  const redirected: string[] = [],
    product: string[] = [];
  page.on("response", (response) => {
    const { pathname } = new URL(response.url());
    if (pathname.startsWith("/api/") && response.status() === 308)
      redirected.push(pathname);
  });
  page.on("request", (request) => {
    const { pathname } = new URL(request.url());
    if (pathname.startsWith("/api/product/")) product.push(pathname);
  });
  // Await each page's own response rather than network idle, which can settle
  // before hydration starts the fetch on a slow machine.
  for (const { path, endpoint } of routes) {
    const answered = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === endpoint &&
        response.status() === 200,
    );
    await page.goto(path);
    expect((await answered).request().redirectedFrom(), path).toBeNull();
  }
  await page
    .getByRole("button", {
      name: "Search tokens, wallets, creators, transactions",
    })
    .click();
  const searched = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/product/search/" &&
      response.status() === 200,
  );
  await page
    .getByRole("dialog", { name: "Search Pools Info" })
    .getByRole("textbox")
    .fill("pool");
  expect((await searched).request().redirectedFrom()).toBeNull();
  expect(redirected).toEqual([]);
  expect(product.filter((pathname) => !pathname.endsWith("/"))).toEqual([]);
  expect(product.length).toBeGreaterThan(routes.length);
});
