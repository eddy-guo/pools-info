import test from "node:test";
import assert from "node:assert/strict";
import {
  getLiveFeedSnapshot,
  getServerLiveFeedSnapshot,
  registerLiveFeedSource,
  reportLiveFeedState,
  subscribeLiveFeedSnapshot,
} from "./live-feed-state";

test("live feed snapshots stay cached while published state keeps updating", () => {
  const server = getServerLiveFeedSnapshot();
  assert.deepEqual(server, { hasSource: false, state: "unknown" });
  assert.strictEqual(getServerLiveFeedSnapshot(), server);

  const initial = getLiveFeedSnapshot();
  let notifications = 0;
  const unsubscribe = subscribeLiveFeedSnapshot(() => notifications++);
  const unregister = registerLiveFeedSource();

  const sourced = getLiveFeedSnapshot();
  assert.notStrictEqual(sourced, initial);
  assert.strictEqual(getLiveFeedSnapshot(), sourced);
  assert.deepEqual(sourced, { hasSource: true, state: "unknown" });

  reportLiveFeedState("streaming");
  const streaming = getLiveFeedSnapshot();
  assert.notStrictEqual(streaming, sourced);
  assert.strictEqual(getLiveFeedSnapshot(), streaming);
  assert.deepEqual(streaming, { hasSource: true, state: "streaming" });
  reportLiveFeedState("streaming");
  assert.strictEqual(getLiveFeedSnapshot(), streaming);
  assert.equal(notifications, 2);

  unregister();
  unsubscribe();
  assert.deepEqual(getLiveFeedSnapshot(), {
    hasSource: false,
    state: "unknown",
  });
  assert.equal(notifications, 3);
});
