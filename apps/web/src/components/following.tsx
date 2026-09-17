"use client";

import Link from "next/link";
import { useMemo, useState, useSyncExternalStore } from "react";
import { UserRoundCheck, UserRoundPlus, X } from "lucide-react";
import { shortAddress } from "@pools/core";
import { Avatar } from "./ui";
import styles from "./following.module.css";
import { FollowActivity } from "./follow-activity";

const key = "poolsinfo.following.v1";
const changed = "poolsinfo-following-changed";
const valid = (address: string) => /^0x[0-9a-f]{40}$/i.test(address);
function read() {
  try {
    return localStorage.getItem(key) ?? "[]";
  } catch {
    return null;
  }
}
function parse(raw: string | null): string[] {
  try {
    if (!raw || raw.length > 20000) return [];
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return [
      ...new Set(
        value
          .filter((a): a is string => typeof a === "string" && valid(a))
          .map((a) => a.toLowerCase()),
      ),
    ].slice(0, 200);
  } catch {
    return [];
  }
}
function subscribe(notify: () => void) {
  const storage = (event: StorageEvent) => {
    if (event.key === key || event.key === null) notify();
  };
  window.addEventListener("storage", storage);
  window.addEventListener(changed, notify);
  return () => {
    window.removeEventListener("storage", storage);
    window.removeEventListener(changed, notify);
  };
}
const serverSnapshot = () => null;
export function useFollowing() {
  const raw = useSyncExternalStore(subscribe, read, serverSnapshot);
  const addresses = useMemo(() => parse(raw), [raw]);
  const [error, setError] = useState("");
  function toggle(address: string) {
    if (!valid(address)) return;
    const id = address.toLowerCase();
    const current = parse(read());
    if (!current.includes(id) && current.length >= 200) {
      setError("You can follow up to 200 wallets in this browser.");
      return;
    }
    const next = current.includes(id)
      ? current.filter((a) => a !== id)
      : [...current, id];
    try {
      localStorage.setItem(key, JSON.stringify(next));
      setError("");
      window.dispatchEvent(new Event(changed));
    } catch {
      setError("Could not save follows in this browser.");
    }
  }
  return { addresses, toggle, error, available: raw !== null };
}

export function FollowButton({ address }: { address: string }) {
  const { addresses, toggle, error, available } = useFollowing();
  const followed = addresses.includes(address.toLowerCase());
  return (
    <div className={styles.control}>
      <button
        type="button"
        className="button secondary"
        aria-pressed={followed}
        disabled={!available}
        title="Saved only in this browser"
        onClick={() => toggle(address)}
      >
        {followed ? <UserRoundCheck size={16} /> : <UserRoundPlus size={16} />}
        {followed ? "Following" : "Follow wallet"}
      </button>
      {error && (
        <span role="alert" className={styles.error}>
          {error}
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
  const { addresses, toggle, available } = useFollowing();
  const followed = addresses.includes(address.toLowerCase());
  return (
    <button
      type="button"
      className={`icon-button follow-toggle ${followed ? "active" : ""}`}
      aria-pressed={followed}
      aria-label={followed ? `Unfollow ${address}` : `Follow ${address}`}
      title="Saved only in this browser"
      disabled={!available}
      onClick={() => toggle(address)}
    >
      {followed ? (
        <UserRoundCheck size={16} fill="currentColor" fillOpacity={0.18} />
      ) : (
        <UserRoundPlus size={16} />
      )}
    </button>
  );
}
export function FollowedWallets() {
  const { addresses, toggle, error } = useFollowing();
  if (!addresses.length) return null;
  return (
    <section className={styles.section} aria-label="Followed wallets">
      <h2>
        Following <span>({addresses.length})</span>
      </h2>
      <p>Saved in this browser. No account or wallet connection needed.</p>
      <ul className={styles.list}>
        {addresses.map((address) => (
          <li key={address}>
            <Link href={`/wallet/${address}/`}>
              <Avatar address={address} />
              <span>
                <strong>{shortAddress(address)}</strong>
                <small>{address}</small>
              </span>
            </Link>
            <button
              type="button"
              className="icon-button"
              aria-label={`Unfollow ${address}`}
              onClick={() => toggle(address)}
            >
              <X size={16} />
            </button>
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      <FollowActivity addresses={addresses} />
    </section>
  );
}
