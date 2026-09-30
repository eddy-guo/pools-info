import assert from "node:assert/strict";
import test from "node:test";
import {
  admissionPolicy,
  createAdmission,
  upstreamIdentity,
  visitorAddress,
} from "./product-admission";

test("the visitor is the platform's last forwarded entry, or nobody", () => {
  assert.equal(
    visitorAddress(new Headers({ "x-forwarded-for": "203.0.113.9" })),
    "203.0.113.9",
  );
  assert.equal(
    visitorAddress(
      new Headers({ "x-forwarded-for": "10.0.0.1, ::ffff:203.0.113.9" }),
    ),
    "203.0.113.9",
  );
  assert.equal(
    visitorAddress(new Headers({ "x-forwarded-for": "2001:DB8::1" })),
    "2001:db8::1",
  );
  assert.equal(visitorAddress(new Headers()), null);
  assert.equal(
    visitorAddress(new Headers({ "x-forwarded-for": "unknown" })),
    null,
  );
  assert.equal(
    visitorAddress(new Headers({ "x-real-ip": "203.0.113.9" })),
    null,
  );
});

test("one visitor's spent line refuses that visitor alone, with the wait to clear it", () => {
  let now = 0;
  const admission = createAdmission(
    { requestsPerMinute: 30, maxVisitors: 100 },
    () => now,
  );
  for (let i = 0; i < 30; i++)
    assert.deepEqual(
      admission.admit("203.0.113.9"),
      { ok: true },
      `request ${i + 1}`,
    );
  // Half a token per second: the 31st request waits two whole seconds.
  assert.deepEqual(admission.admit("203.0.113.9"), {
    ok: false,
    retryAfterSeconds: 2,
  });
  assert.deepEqual(admission.admit("203.0.113.10"), { ok: true });
  assert.deepEqual(admission.admit(null), { ok: true });
  now = 2000;
  assert.deepEqual(admission.admit("203.0.113.9"), { ok: true });
  assert.equal(admissionPolicy.requestsPerMinute, 120);
});

test("IPv6 visitors share a /64 admission bucket while retaining full upstream identity", () => {
  const admission = createAdmission(
    { requestsPerMinute: 2, maxVisitors: 100 },
    () => 0,
  );
  assert.deepEqual(admission.admit("2001:db8:1:2::1"), { ok: true });
  assert.deepEqual(admission.admit("2001:0DB8:1:2::2"), { ok: true });
  assert.deepEqual(admission.admit("2001:db8:1:2::3"), {
    ok: false,
    retryAfterSeconds: 30,
  });
  assert.deepEqual(admission.admit("2001:db8:1:3::1"), { ok: true });
  assert.deepEqual(
    upstreamIdentity("2001:db8:1:2::3", {
      INDEXER_PROXY_SECRET: "s".repeat(16),
    }),
    {
      "X-Pools-Proxy-Secret": "s".repeat(16),
      "X-Pools-Client-Address": "2001:db8:1:2::3",
    },
  );
});

test("the read API learns the visitor only under the shared secret", () => {
  assert.deepEqual(upstreamIdentity("203.0.113.9", {}), {});
  assert.deepEqual(
    upstreamIdentity(null, { INDEXER_PROXY_SECRET: "s".repeat(16) }),
    { "X-Pools-Proxy-Secret": "s".repeat(16) },
  );
  assert.deepEqual(
    upstreamIdentity("203.0.113.9", { INDEXER_PROXY_SECRET: "s".repeat(16) }),
    {
      "X-Pools-Proxy-Secret": "s".repeat(16),
      "X-Pools-Client-Address": "203.0.113.9",
    },
  );
});
