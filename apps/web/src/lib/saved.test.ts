import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {
  FOLLOWING_KEY,
  LEGACY_WATCHLIST_KEY,
  WATCHLIST_KEY,
  YOU_PAGE_STEP,
  parseFollowing,
  savedBadge,
  savedCount,
  savedCountsFromStorage,
  youPrepaintScript,
} from "./saved";

const wallet = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const pool = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

/** Runs the inline pre-paint script against a fake browser: a storage that
    may throw, and a document root that records what the script set. */
function prepaint(
  storage: Record<string, string> | (() => never),
): { vars: Map<string, string>; attrs: Map<string, string> } {
  const vars = new Map<string, string>();
  const attrs = new Map<string, string>();
  const context = {
    localStorage: {
      getItem: (key: string) =>
        typeof storage === "function"
          ? storage()
          : Object.hasOwn(storage, key)
            ? storage[key]
            : null,
    },
    document: {
      documentElement: {
        style: { setProperty: (k: string, v: string) => vars.set(k, v) },
        setAttribute: (k: string, v: string) => attrs.set(k, v),
      },
    },
  };
  vm.runInNewContext(youPrepaintScript, context);
  return { vars, attrs };
}

test("the follow list keeps valid addresses once, lower-cased, in order, up to the cap", () => {
  assert.deepEqual(parseFollowing(null), []);
  assert.deepEqual(parseFollowing(""), []);
  assert.deepEqual(parseFollowing("not json"), []);
  assert.deepEqual(parseFollowing('{"a":1}'), []);
  assert.deepEqual(
    parseFollowing(
      JSON.stringify([
        wallet(2).toUpperCase().replace("0X", "0x"),
        wallet(1),
        "0x123",
        7,
        wallet(2),
      ]),
    ),
    [wallet(2), wallet(1)],
  );
  const many = Array.from({ length: 260 }, (_, i) => wallet(i + 1));
  assert.equal(parseFollowing(JSON.stringify(many)).length, 200);
  const oversized = JSON.stringify(
    Array.from({ length: 500 }, (_, i) => wallet(i + 1)),
  );
  assert.ok(oversized.length > 20000);
  assert.deepEqual(parseFollowing(oversized), []);
});

test("the badge reads nothing at zero, the count to 99, then 99+", () => {
  assert.equal(savedBadge(0), "");
  assert.equal(savedBadge(-1), "");
  assert.equal(savedBadge(1), "1");
  assert.equal(savedBadge(99), "99");
  assert.equal(savedBadge(100), "99+");
  assert.equal(savedBadge(250), "99+");
});

test("the saved count is followed wallets plus watched pools", () => {
  assert.equal(savedCount(0, 0), 0);
  assert.equal(savedCount(2, 3), 5);
  assert.equal(savedCount(200, 0), 200);
});

const cases: [string, Record<string, string> | (() => never)][] = [
  ["nothing stored", {}],
  [
    "both lists",
    {
      [FOLLOWING_KEY]: JSON.stringify([wallet(1), wallet(2), wallet(1)]),
      [WATCHLIST_KEY]: JSON.stringify([pool(1), ` ${pool(2)} `, pool(3)]),
    },
  ],
  [
    "mixed case, repeats and junk",
    {
      [FOLLOWING_KEY]: JSON.stringify([
        wallet(3).replace("0x", "0X"),
        wallet(3),
        "0xnope",
        5,
      ]),
      [WATCHLIST_KEY]: JSON.stringify([
        pool(4).toUpperCase().replace("0X", "0x"),
        pool(4),
        "0xshort",
        null,
      ]),
    },
  ],
  [
    "the legacy watchlist key when the versioned one is missing",
    { [LEGACY_WATCHLIST_KEY]: JSON.stringify([pool(5), pool(6)]) },
  ],
  [
    "the legacy watchlist key when the versioned one is empty text",
    { [WATCHLIST_KEY]: "", [LEGACY_WATCHLIST_KEY]: JSON.stringify([pool(7)]) },
  ],
  [
    "an explicitly empty versioned watchlist shadows a legacy list",
    { [WATCHLIST_KEY]: "[]", [LEGACY_WATCHLIST_KEY]: JSON.stringify([pool(8)]) },
  ],
  [
    "unreadable JSON in either key",
    { [FOLLOWING_KEY]: "{oops", [WATCHLIST_KEY]: "[1," },
  ],
  [
    "lists past the page's step and the follow cap",
    {
      [FOLLOWING_KEY]: JSON.stringify(
        Array.from({ length: 230 }, (_, i) => wallet(i + 1)),
      ),
      [WATCHLIST_KEY]: JSON.stringify(
        Array.from({ length: 40 }, (_, i) => pool(i + 1)),
      ),
    },
  ],
  [
    "a follow list past the size the store refuses to read",
    {
      [FOLLOWING_KEY]: JSON.stringify(
        Array.from({ length: 500 }, (_, i) => wallet(i + 1)),
      ),
    },
  ],
  [
    "a storage that throws",
    () => {
      throw new Error("SecurityError");
    },
  ],
];

for (const [name, storage] of cases)
  test(`the pre-paint script agrees with the stores: ${name}`, () => {
    const get = (key: string) => {
      try {
        return typeof storage === "function"
          ? storage()
          : Object.hasOwn(storage, key)
            ? storage[key]
            : null;
      } catch {
        return null;
      }
    };
    const expected = savedCountsFromStorage(get);
    const { vars, attrs } = prepaint(storage);
    assert.equal(
      vars.get("--you-following-rows"),
      String(Math.min(expected.following, YOU_PAGE_STEP)),
    );
    assert.equal(
      vars.get("--you-watchlist-rows"),
      String(Math.min(expected.watchlist, YOU_PAGE_STEP)),
    );
    assert.equal(
      attrs.get("data-you-following"),
      expected.following ? "some" : "none",
    );
    assert.equal(
      attrs.get("data-you-watchlist"),
      expected.watchlist ? "some" : "none",
    );
  });

test("the pre-paint cases cover both empty and populated lists", () => {
  const seen = { some: 0, none: 0 };
  for (const [, storage] of cases) {
    const { attrs } = prepaint(storage);
    seen[attrs.get("data-you-following") as "some" | "none"]++;
    seen[attrs.get("data-you-watchlist") as "some" | "none"]++;
  }
  assert.ok(seen.some > 0 && seen.none > 0);
});
