import {
  SnapshotReader,
  type Snapshot,
  type AnalyticsReader,
} from "@pools/core";
import snapshot from "../../../../data/snapshots/demo.json";

// The only application module that knows where the snapshot lives.
// A server/API reader can replace this without changing view contracts.
export const reader: AnalyticsReader = new SnapshotReader(snapshot as Snapshot);
