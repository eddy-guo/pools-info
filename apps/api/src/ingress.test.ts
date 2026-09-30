import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import {
  clientIdentity,
  clientKey,
  identitySources,
  ingressSettings,
  normalizeAddress,
  routeCostClass,
  trustedProxyList,
} from "./ingress";

const request = (
  headers: Record<string, string | string[]>,
  remoteAddress: string | undefined = "127.0.0.1",
) => ({ headers, socket: { remoteAddress } });

test("addresses normalize as sockets and proxies write them, and IPv6 clients share a /64", () => {
  assert.equal(normalizeAddress("::ffff:203.0.113.9"), "203.0.113.9");
  assert.equal(normalizeAddress(" 203.0.113.9:5000 "), "203.0.113.9");
  assert.equal(normalizeAddress("[2001:db8::1]"), "2001:db8::1");
  assert.equal(normalizeAddress("fe80::1%en0"), "fe80::1");
  assert.equal(normalizeAddress("2001:DB8::A"), "2001:db8::a");
  for (const bad of [
    "",
    "unknown",
    "203.0.113",
    "2001:db8::/64",
    "203.0.113.9:x",
    "[2001:db8::1",
    undefined,
    null,
  ])
    assert.equal(normalizeAddress(bad), null, String(bad));
  assert.equal(clientKey("203.0.113.9"), "203.0.113.9");
  assert.equal(clientKey("2001:0db8:1:2:3:4:5:6"), "2001:db8:1:2::/64");
  assert.equal(
    clientKey("2001:db8:1:2::9"),
    clientKey("2001:db8:1:2:ffff:ffff:ffff:ffff"),
  );
  assert.notEqual(clientKey("2001:db8:1:2::9"), clientKey("2001:db8:1:3::9"));
  assert.equal(clientKey("::1"), "0:0:0:0::/64");
  assert.equal(clientKey("1::"), "1:0:0:0::/64");
  assert.equal(clientKey("64:ff9b::203.0.113.9"), "64:ff9b:0:0::/64");
});

test("an unconfigured api names no client; peer mode names the connection itself", () => {
  const off = ingressSettings({}).identity;
  assert.equal(
    clientIdentity(request({ "x-forwarded-for": "203.0.113.1" }), off),
    null,
  );
  const peer = ingressSettings({ CLIENT_IDENTITY: "peer" }).identity;
  assert.equal(
    clientIdentity(
      request({ "x-forwarded-for": "203.0.113.1" }, "::ffff:198.51.100.7"),
      peer,
    ),
    "198.51.100.7",
  );
  assert.equal(clientIdentity({ headers: {}, socket: {} }, peer), null);
});

test("only a trusted peer's last forwarded entry names the client; direct traffic is its peer", () => {
  const identity = ingressSettings({
    TRUSTED_PROXY_ADDRESSES: "10.0.0.0/8, 2001:db8::/32",
  }).identity;
  // Direct traffic: the forwarded header is ignored and the peer is the client.
  assert.equal(
    clientIdentity(
      request({ "x-forwarded-for": "203.0.113.1" }, "198.51.100.7"),
      identity,
    ),
    "198.51.100.7",
  );
  // Through the proxy: the entry the proxy appended last outranks anything
  // the caller wrote before it, however the header was split.
  assert.equal(
    clientIdentity(
      request({ "x-forwarded-for": "203.0.113.1, 198.51.100.7" }, "10.1.2.3"),
      identity,
    ),
    "198.51.100.7",
  );
  assert.equal(
    clientIdentity(
      request(
        { "x-forwarded-for": ["203.0.113.1", "198.51.100.7"] },
        "10.1.2.3",
      ),
      identity,
    ),
    "198.51.100.7",
  );
  assert.equal(
    clientIdentity(
      request({ "x-forwarded-for": "2001:db8:9:8::1" }, "2001:db8::1"),
      identity,
    ),
    "2001:db8:9:8::/64",
  );
  // A trusted proxy that forwarded nothing usable leaves the request
  // unidentified rather than folding every caller into the proxy's own key.
  assert.equal(clientIdentity(request({}, "10.1.2.3"), identity), null);
  assert.equal(
    clientIdentity(
      request({ "x-forwarded-for": "unknown" }, "10.1.2.3"),
      identity,
    ),
    null,
  );
});

test("the proxy secret names the visitor only when it matches exactly", () => {
  const secret = randomBytes(32).toString("hex");
  const identity = ingressSettings({
    TRUSTED_PROXY_SECRET: secret,
    TRUSTED_PROXY_ADDRESSES: "10.0.0.0/8",
  }).identity;
  assert.equal(
    clientIdentity(
      request(
        {
          "x-pools-proxy-secret": secret,
          "x-pools-client-address": "203.0.113.5",
        },
        "198.51.100.7",
      ),
      identity,
    ),
    "203.0.113.5",
  );
  // Through the edge too: the secret outranks the forwarded chain.
  assert.equal(
    clientIdentity(
      request(
        {
          "x-pools-proxy-secret": secret,
          "x-pools-client-address": "::ffff:203.0.113.5",
          "x-forwarded-for": "198.51.100.7",
        },
        "10.1.2.3",
      ),
      identity,
    ),
    "203.0.113.5",
  );
  // A wrong, truncated, extended or absent secret falls back to the address
  // contract, under which this direct peer is the client.
  for (const wrong of [
    secret.slice(0, -1),
    secret + "!",
    (secret[0] === "a" ? "b" : "a") + secret.slice(1),
    "",
  ])
    assert.equal(
      clientIdentity(
        request(
          {
            "x-pools-proxy-secret": wrong,
            "x-pools-client-address": "203.0.113.5",
          },
          "198.51.100.7",
        ),
        identity,
      ),
      "198.51.100.7",
      JSON.stringify(wrong),
    );
  assert.equal(
    clientIdentity(
      request({ "x-pools-client-address": "203.0.113.5" }, "198.51.100.7"),
      identity,
    ),
    "198.51.100.7",
  );
  // A matching secret that names no usable visitor leaves the request unidentified.
  assert.equal(
    clientIdentity(
      request({ "x-pools-proxy-secret": secret }, "198.51.100.7"),
      identity,
    ),
    null,
  );
  assert.equal(
    clientIdentity(
      request(
        { "x-pools-proxy-secret": secret, "x-pools-client-address": "visitor" },
        "198.51.100.7",
      ),
      identity,
    ),
    null,
  );
});

test("settings parse their variables and refuse malformed values", () => {
  const defaults = ingressSettings({});
  assert.deepEqual(defaults, {
    clientTokensPerMinute: 60,
    clientTokenBurst: 150,
    maxClients: 10000,
    probesPerMinute: 60,
    identity: { trustedProxies: null, peer: false, proxySecret: null },
  });
  assert.deepEqual(identitySources(defaults.identity), []);
  const warnings: string[] = [];
  const full = ingressSettings({
    CLIENT_TOKENS_PER_MINUTE: "300",
    CLIENT_TOKEN_BURST: "300",
    TRUSTED_PROXY_ADDRESSES: "127.0.0.1",
    CLIENT_IDENTITY: "peer",
    TRUSTED_PROXY_SECRET: randomBytes(32).toString("hex"),
  }, (message) => warnings.push(message));
  assert.equal(full.clientTokensPerMinute, 119);
  assert.equal(full.clientTokenBurst, 120);
  assert.ok(full.clientTokensPerMinute + full.clientTokenBurst < 240);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /CLIENT_TOKENS_PER_MINUTE/);
  assert.match(warnings[0], /CLIENT_TOKEN_BURST/);
  const large = ingressSettings(
    { CLIENT_TOKEN_BURST: "1000000" },
    (message) => warnings.push(message),
  );
  assert.equal(large.clientTokensPerMinute, 60);
  assert.equal(large.clientTokenBurst, 179);
  assert.equal(warnings.length, 2);
  assert.match(warnings[1], /CLIENT_TOKEN_BURST/);
  assert.deepEqual(identitySources(full.identity), [
    "proxy_secret",
    "trusted_proxies",
    "peer",
  ]);
  for (const env of [
    { CLIENT_TOKENS_PER_MINUTE: "9" },
    { CLIENT_TOKENS_PER_MINUTE: "abc" },
    { CLIENT_TOKEN_BURST: "9" },
    { CLIENT_TOKEN_BURST: "abc" },
    { CLIENT_IDENTITY: "forwarded" },
    { TRUSTED_PROXY_SECRET: "short" },
    { TRUSTED_PROXY_ADDRESSES: "example.com" },
    { TRUSTED_PROXY_ADDRESSES: "10.0.0.0/33" },
    { TRUSTED_PROXY_ADDRESSES: "10.0.0.0/8/1" },
    { TRUSTED_PROXY_ADDRESSES: "2001:db8::/129" },
  ])
    assert.throws(() => ingressSettings(env), JSON.stringify(env));
  const list = trustedProxyList("::ffff:10.0.0.1, 192.0.2.0/24, ::1")!;
  assert.equal(list.check("10.0.0.1", "ipv4"), true);
  assert.equal(list.check("10.0.0.2", "ipv4"), false);
  assert.equal(list.check("192.0.2.200", "ipv4"), true);
  assert.equal(list.check("192.0.3.1", "ipv4"), false);
  assert.equal(list.check("::1", "ipv6"), true);
  assert.equal(trustedProxyList(" , "), null);
});

test("routes fall into cost classes by the work they start", () => {
  assert.equal(routeCostClass("history"), "paid");
  assert.equal(routeCostClass("following"), "paid");
  for (const route of ["explore", "creators", "search", "profile"] as const)
    assert.equal(routeCostClass(route), "heavy", route);
  for (const route of [
    "status",
    "pools",
    "pool",
    "trades",
    "trade-share",
    "wallet",
    "stats",
    "leaderboard",
    "feed",
    "live-trades",
  ] as const)
    assert.equal(routeCostClass(route), "light", route);
  assert.equal(routeCostClass("eth-price"), "cached");
});
