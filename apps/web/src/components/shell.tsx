"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Wallet } from "lucide-react";
import { formatMoney } from "@pools/core";
import { validateLiveFeed } from "@/lib/live-feed";
import {
  getLiveFeedSnapshot,
  getServerLiveFeedSnapshot,
  subscribeLiveFeedSnapshot,
  type LiveFeedState,
} from "@/lib/live-feed-state";
import { Search } from "./search";
import { UnitToggle } from "./unit-toggle";
import { useEthPrice } from "./eth-price-provider";

const oneEthWei = (10n ** 18n).toString();
const LIVE_FEED_POLL_MS = 15000;

/** Whether the trade feed the header's dot reports on is currently streaming.
    A page that already streams (TradeStream) registers itself as a source
    and this reads that poll's state; only a page with no such source polls
    on its own, so the feed is never polled twice. Starts "unknown" (a
    neutral dot, no label) rather than claiming either state before a read
    confirms it; a failed read reads as "paused", never as streaming. */
function useLiveFeedState(): LiveFeedState {
  const { hasSource, state: reported } = useSyncExternalStore(
    subscribeLiveFeedSnapshot,
    getLiveFeedSnapshot,
    getServerLiveFeedSnapshot,
  );
  const [polled, setPolled] = useState<LiveFeedState>("unknown");
  useEffect(() => {
    // A page's own TradeStream registers in the same commit, before this
    // effect runs (a descendant's effects fire first): read the live
    // snapshot here rather than trust `hasSource` from this render, or the
    // very first mount of a page that already streams starts a second poll
    // for the one tick before that registration is reflected back down.
    if (getLiveFeedSnapshot().hasSource) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      if (document.hidden) return;
      try {
        const response = await fetch("/api/live-trades/", {
          cache: "no-store",
          signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) throw Error("unavailable");
        const data = validateLiveFeed(await response.json());
        if (!cancelled)
          setPolled(
            data.coverage.state === "current" ? "streaming" : "paused",
          );
      } catch {
        if (!cancelled) setPolled("paused");
      } finally {
        if (!cancelled) timer = setTimeout(poll, LIVE_FEED_POLL_MS);
      }
    }
    function onVisible() {
      if (!document.hidden) {
        clearTimeout(timer);
        void poll();
      }
    }
    document.addEventListener("visibilitychange", onVisible);
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [hasSource]);
  return hasSource ? reported : polled;
}

export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const usdPerEth = useEthPrice();
  const liveFeed = useLiveFeedState();
  return (
    <div className="site-shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="site-header">
        <div className="topbar">
          <Link href="/" className="brand" aria-label="Pools Info home">
            <svg
              className="brand-orbits"
              width="22"
              height="26"
              viewBox="0 0 22 26"
              fill="none"
              aria-hidden="true"
            >
              <ellipse
                cx="11"
                cy="6"
                rx="9"
                ry="4.4"
                stroke="currentColor"
                strokeWidth="1.8"
              />
              <ellipse
                cx="11"
                cy="12.4"
                rx="9"
                ry="4.4"
                stroke="currentColor"
                strokeWidth="1.8"
                opacity=".62"
              />
              <ellipse
                cx="11"
                cy="18.8"
                rx="9"
                ry="4.4"
                stroke="currentColor"
                strokeWidth="1.8"
                opacity=".3"
              />
            </svg>
            <span>
              pools<span className="brand-light">info</span>
              <span className="brand-period">.</span>
            </span>
          </Link>
          <nav className="primary-nav" aria-label="Main navigation">
            {[
              { label: "Pools", href: "/" },
              { label: "Traders", href: "/traders/" },
              { label: "Creators", href: "/creators/" },
            ].map((item) => {
              const active =
                item.href === "/"
                  ? pathname === "/" || pathname.startsWith("/pool/")
                  : pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={active ? "active" : ""}
                  aria-current={active ? "page" : undefined}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
          <div className="header-actions">
            <Search />
            <UnitToggle />
            {/* Holds the top-right slot where the wallet profile entry will live. */}
            <button
              type="button"
              className="connect-button"
              aria-disabled="true"
              aria-label="Connect wallet, coming soon"
              title="Wallet connection is coming soon"
            >
              <Wallet size={15} />
              <span className="connect-label">Connect wallet</span>
              <span className="connect-soon">Soon</span>
            </button>
          </div>
        </div>
        <div className="network-subnav">
          <span className="subnav-live" data-state={liveFeed} role="status">
            <i aria-hidden="true" />
            <span className="subnav-live-label">
              <span className="subnav-live-value">
                {liveFeed === "streaming"
                  ? "Live"
                  : liveFeed === "paused"
                    ? "Paused"
                    : ""}
              </span>
            </span>
          </span>
          <span className="network-context">v4 · Robinhood Chain</span>
          <span className="subnav-divider" aria-hidden="true" />
          <span
            className="subnav-eth-price"
            style={{ visibility: usdPerEth === null ? "hidden" : "visible" }}
          >
            {usdPerEth !== null &&
              `ETH ${formatMoney(oneEthWei, "USD", usdPerEth)}`}
          </span>
        </div>
      </header>
      <main id="main">{children}</main>
      <footer className="footer">
        <span>Independent analytics. Not affiliated with Uniswap Labs.</span>
        <div>
          <span>Robinhood Chain · Values in ETH</span>
        </div>
      </footer>
    </div>
  );
}
