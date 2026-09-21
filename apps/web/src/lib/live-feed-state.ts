/**
 * The trade feed's state as the rail (`TradeStream`) names it: `unknown`
 * until a first read answers, then the rail's own word, so the header strip
 * can only ever show what the rail shows. `paused` is the reader's own
 * choice; `offline` a feed that has never started; `delayed` a feed whose
 * window is stale or whose last read failed.
 */
export type LiveFeedState =
  | "unknown"
  | "streaming"
  | "delayed"
  | "paused"
  | "offline";
type Snapshot = { hasSource: boolean; state: LiveFeedState };
type Listener = () => void;

let sources = 0;
let reported: LiveFeedState = "unknown";
const serverSnapshot: Snapshot = { hasSource: false, state: "unknown" };
let snapshot = serverSnapshot;
const listeners = new Set<Listener>();

function recompute() {
  const hasSource = sources > 0;
  const state = hasSource ? reported : "unknown";
  if (snapshot.hasSource === hasSource && snapshot.state === state) return;
  snapshot = { hasSource, state };
  for (const listener of listeners) listener();
}

/** Registered by a component that already polls the live trade feed
    (TradeStream), so the header strip's dot reads that poll's real state
    instead of ever starting a second one on a page that already streams. */
export function registerLiveFeedSource() {
  sources++;
  recompute();
  return () => {
    sources--;
    if (sources === 0) reported = "unknown";
    recompute();
  };
}

export function reportLiveFeedState(state: LiveFeedState) {
  reported = state;
  recompute();
}

export function subscribeLiveFeedSnapshot(listener: Listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getLiveFeedSnapshot(): Snapshot {
  return snapshot;
}

export function getServerLiveFeedSnapshot(): Snapshot {
  return serverSnapshot;
}
