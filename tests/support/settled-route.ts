import type { Page, Request, Route } from "@playwright/test";

type Handler = (route: Route, request: Request) => Promise<unknown> | unknown;

const pages = new WeakMap<
  Page,
  { closing: boolean; inFlight: Set<Promise<unknown>> }
>();

function state(page: Page) {
  let entry = pages.get(page);
  if (!entry)
    pages.set(page, (entry = { closing: false, inFlight: new Set() }));
  return entry;
}

/** `page.route` for a handler that reads the real response (`route.fetch()`)
    before it fulfils: a test can end while one is still waiting on that read,
    and the page's close then disposes the response under it ("apiResponse.json:
    Response has been disposed", reported as an error outside any test). Pair
    it with `settleRoutes(page)` in `test.afterEach`, which runs before the
    page closes.

    `page.unrouteAll({ behavior: "wait" })` is not the cure in Playwright
    1.63: once the route list is empty, the first in-flight handler to finish
    clears the page's interception patterns, which continues every other
    in-flight route underneath its own handler ("route.fulfill: Route is
    already handled!"). */
export async function settledRoute(page: Page, url: string, handler: Handler) {
  const routes = state(page);
  await page.route(url, (route, request) => {
    // Teardown has begun: let the request through untouched rather than
    // start a read the page's close would dispose.
    if (routes.closing) return route.fallback();
    const run = Promise.resolve(handler(route, request)).finally(() =>
      routes.inFlight.delete(run),
    );
    routes.inFlight.add(run);
    return run;
  });
}

/** Stops new `settledRoute` reads on this page and waits for those already
    running to fulfil, so none outlives the test. */
export async function settleRoutes(page: Page) {
  const routes = state(page);
  routes.closing = true;
  while (routes.inFlight.size) await Promise.allSettled([...routes.inFlight]);
}
