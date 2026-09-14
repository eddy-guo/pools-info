"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ArrowUpRight,
  BookOpen,
  Wallet,
  Pause,
  Play,
  RefreshCw,
} from "lucide-react";
import { FeaturePreview } from "./feature-preview";
import { Search } from "./search";
import { useLive } from "./live-provider";

export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
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
              { label: "Wallet", href: "/wallet/" },
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
            <span
              className="currency-pill"
              title="All market amounts are denominated in ETH"
            >
              ETH
            </span>
            <FeaturePreview feature="connect" className="button connect-button">
              <Wallet size={15} />
              <span>Connect wallet</span>
            </FeaturePreview>
          </div>
        </div>
        <ShellStatus />
      </header>
      <main id="main">{children}</main>
      <footer className="footer">
        <span>Independent analytics. Not affiliated with Uniswap Labs.</span>
        <div>
          <span>Robinhood Chain · Values in ETH</span>
          <Link href="/methodology/">
            <BookOpen size={13} /> Methodology
          </Link>
        </div>
      </footer>
    </div>
  );
}

function ShellStatus() {
  const { snapshot, status, enabled, setEnabled, refresh } = useLive();
  const labels: Record<string, string> = {
    checking: "Checking for updates",
    current: "Automatic updates active",
    delayed: "Updates delayed - showing last captured data",
    paused: "Updates paused",
  };
  const captured = new Date(snapshot.generatedAt).toISOString();
  return (
    <div className={`network-subnav ${status === "delayed" ? "stale" : ""}`}>
      <strong role="status" className="status-label">
        <span className="network-indicator" />
        {labels[status]}
      </strong>
      <span className="network-context">Uniswap v4 · Robinhood Chain</span>
      <span className="mono">
        block {snapshot.toBlock.toLocaleString("en-US")}
      </span>
      <span className="capture-time" title={`Captured ${captured}`}>
        Captured {captured.slice(5, 10)} {captured.slice(11, 16)} UTC
      </span>
      <span className="coverage-tag">
        {snapshot.markets.length} covered pools
      </span>
      <div className="status-actions">
        <button
          className="icon-button"
          title={enabled ? "Pause updates" : "Resume updates"}
          aria-label={enabled ? "Pause updates" : "Resume updates"}
          onClick={() => setEnabled(!enabled)}
        >
          {enabled ? <Pause size={12} /> : <Play size={12} />}
        </button>
        <button
          className="icon-button"
          title="Check now"
          aria-label="Check now"
          onClick={refresh}
        >
          <RefreshCw size={12} />
        </button>
        <Link href="/methodology/">
          Methodology <ArrowUpRight size={11} />
        </Link>
      </div>
    </div>
  );
}
