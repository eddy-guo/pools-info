"use client";

import { UserRoundCheck, UserRoundPlus } from "lucide-react";
import { useProfileStore } from "@/lib/profile-store";
import { confirmFollow } from "./saved-toast";
import styles from "./following.module.css";

export { useFollowing } from "./following-store";

/** Toggles the follow and raises its confirmation; Undo toggles it back
    without a second note. */
function useFollowToggle(address: string) {
  const { toggleFollow } = useProfileStore();
  return () =>
    confirmFollow(toggleFollow(address), address, () => toggleFollow(address));
}

export function FollowButton({ address }: { address: string }) {
  const { follow, followError, available } = useProfileStore();
  const followed = follow.includes(address.toLowerCase());
  const toggle = useFollowToggle(address);
  return (
    <div className={styles.control}>
      {/* The visible label carries the state ("Follow wallet" / "Following"),
          so this is a plain button: aria-pressed would say it twice. */}
      <button
        type="button"
        className="button secondary"
        disabled={!available}
        onClick={toggle}
      >
        {followed ? <UserRoundCheck size={16} /> : <UserRoundPlus size={16} />}
        {followed ? "Following" : "Follow wallet"}
      </button>
      {followError && (
        <span role="alert" className={styles.error}>
          {followError}
        </span>
      )}
    </div>
  );
}

/** The row-level toggle: an icon target beside a leaderboard row's identity,
    the export's row hover reveals actions on desktop and it stays visible on
    the phone's 44px target. Its pressed state is a filled, accent-coloured
    icon so a followed row reads at a glance. */
export function FollowRowButton({ address }: { address: string }) {
  const { follow, available } = useProfileStore();
  const followed = follow.includes(address.toLowerCase());
  const toggle = useFollowToggle(address);
  return (
    <button
      type="button"
      className={`icon-button follow-toggle ${followed ? "active" : ""}`}
      aria-pressed={followed}
      aria-label={`Follow ${address}`}
      disabled={!available}
      onClick={toggle}
    >
      {followed ? (
        <UserRoundCheck size={16} fill="currentColor" fillOpacity={0.18} />
      ) : (
        <UserRoundPlus size={16} />
      )}
    </button>
  );
}
