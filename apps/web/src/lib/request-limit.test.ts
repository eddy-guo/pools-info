import test from "node:test";
import assert from "node:assert/strict";
import { fetchPastRequestLimit, isRequestLimited } from "./request-limit";
import {
  DATA_UNAVAILABLE,
  fetchProduct,
  OUTSIDE_COVERAGE,
} from "./use-product";

/** The proxy's per-visitor refusal, as its contract documents it. */
const refused = (retryAfter?: string) =>
  Response.json(
    { error: "data_unavailable", reason: "request_limit" },
    {
      status: 503,
      headers: retryAfter === undefined ? {} : { "Retry-After": retryAfter },
    },
  );

function reads(...responses: Response[]) {
  let calls = 0;
  return {
    request: async () => responses[Math.min(calls++, responses.length - 1)],
    calls: () => calls,
  };
}

test("a request_limit 503 is recognised by its documented reason alone", async () => {
  assert.equal(await isRequestLimited(refused("1")), true);
  assert.equal(
    await isRequestLimited(
      Response.json({ error: "data_unavailable" }, { status: 503 }),
    ),
    false,
  );
  assert.equal(
    await isRequestLimited(
      Response.json(
        { error: "data_unavailable", reason: "warming" },
        { status: 503 },
      ),
    ),
    false,
  );
  assert.equal(
    await isRequestLimited(
      Response.json({ reason: "request_limit" }, { status: 429 }),
    ),
    false,
  );
});

test("a refused read waits its Retry-After and is answered by the next one", async () => {
  const answer = Response.json({ ok: true });
  const { request, calls } = reads(refused("0"), refused("0"), answer);
  const response = await fetchPastRequestLimit(
    request,
    new AbortController().signal,
  );
  assert.equal(response, answer);
  assert.equal(calls(), 3);
});

test("a refusal that outlasts the minute ceiling reads as the shared unavailable sentence", async () => {
  let now = 1_000_000;
  const { request, calls } = reads(refused("0"), refused("2"));
  const clock = () => now;
  const pending = fetchPastRequestLimit(
    async () => {
      const response = await request();
      now += 59_000;
      return response;
    },
    new AbortController().signal,
    clock,
  );
  await assert.rejects(pending, { message: DATA_UNAVAILABLE });
  assert.equal(calls(), 2);
});

test("a refusal without usable Retry-After guidance is not retried blindly", async () => {
  for (const guidance of [undefined, "soon"]) {
    const { request, calls } = reads(refused(guidance), Response.json({}));
    await assert.rejects(
      fetchPastRequestLimit(request, new AbortController().signal),
      { message: DATA_UNAVAILABLE },
    );
    assert.equal(calls(), 1);
  }
});

test("every other answer, an outage 503 included, is the caller's to read", async () => {
  for (const answer of [
    Response.json({ error: "data_unavailable" }, { status: 503 }),
    Response.json({ error: "not_found" }, { status: 404 }),
  ]) {
    const { request, calls } = reads(answer);
    assert.equal(
      await fetchPastRequestLimit(request, new AbortController().signal),
      answer,
    );
    assert.equal(calls(), 1);
  }
});

test("a cancelled wait stops the retry", async () => {
  const controller = new AbortController();
  const { request } = reads(refused("30"));
  const pending = fetchPastRequestLimit(request, controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
});

test("fetchProduct only ever fails with one of the two shared sentences", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const failWith = async (fetcher: typeof fetch) => {
    globalThis.fetch = fetcher;
    return fetchProduct("leaderboard?window=7d", new AbortController().signal);
  };
  await assert.rejects(
    failWith(async () => {
      throw new TypeError("Failed to fetch");
    }),
    { message: DATA_UNAVAILABLE },
  );
  await assert.rejects(
    failWith(async () => new Response("not json", { status: 200 })),
    { message: DATA_UNAVAILABLE },
  );
  await assert.rejects(
    failWith(async () =>
      Response.json({ error: "data_unavailable" }, { status: 503 }),
    ),
    { message: DATA_UNAVAILABLE },
  );
  await assert.rejects(
    failWith(async () => Response.json({}, { status: 404 })),
    { message: OUTSIDE_COVERAGE },
  );
});

test("fetchProduct passes the caller's own cancellation through", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const controller = new AbortController();
  globalThis.fetch = async () => {
    controller.abort();
    throw controller.signal.reason;
  };
  await assert.rejects(fetchProduct("leaderboard", controller.signal), {
    name: "AbortError",
  });
});
