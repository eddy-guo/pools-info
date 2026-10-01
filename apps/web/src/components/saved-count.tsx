"use client";
import { useProfileStore } from "@/lib/profile-store";
import { savedBadge, savedCount } from "@/lib/saved";

/** How many things this device has saved, read through the profile facade
    so the figures are never stale against the lists they count: watched
    pools, followed wallets and their sum. Zero on the server and until
    hydration. */
export function useSavedCount() {
  const { follow, watch } = useProfileStore();
  return {
    watch: watch.length,
    follow: follow.length,
    total: savedCount(follow.length, watch.length),
  };
}

/**
 * The count on the header's entry (`.connect-count` in globals.css): inside
 * the fixed-width entry on desktop and at the corner of the 44px phone
 * square, mounted only once something is saved and keyed by its text so a
 * change is a new node rather than text rewritten in place. The entry's
 * accessible name carries the counts; the badge itself is decoration.
 */
export function SavedCountBadge({ count }: { count: number }) {
  const badge = savedBadge(count);
  if (!badge) return null;
  return (
    <span className="connect-count" key={badge} aria-hidden="true">
      {badge}
    </span>
  );
}
