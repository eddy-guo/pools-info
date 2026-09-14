"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  BookOpen,
  ChevronDown,
  Command,
  Search,
  X,
} from "lucide-react";
import { snapshotSearch } from "@/lib/search";
import type { SearchResult } from "@pools/core";
import { useCurrency, useManifest } from "./state";

export function Shell({
  children,
  searchIndex,
}: {
  children: React.ReactNode;
  searchIndex: SearchResult[];
}) {
  const pathname = usePathname();
  const onChain = pathname.startsWith("/live");
  const { currency, setCurrency } = useCurrency();
  const manifest = useManifest();
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(searchIndex);
  const [searchError, setSearchError] = useState("");
  const [loading, setLoading] = useState(false);
  const nav = [
    { label: "On-chain", href: "/live/" },
    { label: "Pools", href: "/" },
    { label: "Traders", href: "/traders/" },
    { label: "Creators", href: "/creators/" },
  ];
  function openSearch() {
    dialog.current?.showModal();
    input.current?.focus();
    setLoading(true);
    setSearchError("");
    void snapshotSearch
      .searchIndex()
      .then(setIndex)
      .catch(() =>
        setSearchError(
          "Transaction search is unavailable. Token and wallet search still works.",
        ),
      )
      .finally(() => setLoading(false));
  }
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!onChain && (e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        openSearch();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onChain]);
  const matches = query.trim()
    ? index.filter((r) =>
        `${r.title} ${r.subtitle}`
          .toLowerCase()
          .includes(query.trim().toLowerCase()),
      )
    : index.filter((r) => r.type === "Token").slice(0, 5);
  function close() {
    dialog.current?.close();
    setQuery("");
  }
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <Link href="/" className="brand" aria-label="Pools Info home">
          <span className="brand-symbol" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span>
            pools<span className="brand-light">info</span>
            <span className="brand-period">.</span>
          </span>
        </Link>
        <nav className="primary-nav" aria-label="Main navigation">
          {nav.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className={
                (
                  n.href === "/"
                    ? pathname === "/" || pathname.startsWith("/pool/")
                    : pathname.startsWith(n.href)
                )
                  ? "active"
                  : ""
              }
            >
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="header-actions">
          {!onChain && (
            <button
              className="search-trigger"
              onClick={openSearch}
              aria-label="Search tokens, wallets, transactions"
            >
              <Search size={16} />
              <span>Search tokens, wallets, transactions</span>
              <kbd>
                <Command size={11} /> K
              </kbd>
            </button>
          )}
          <span className="network-badge">
            <span className="network-mark">R</span>
            <span>Robinhood</span>
          </span>
          {!onChain && (
            <button
              className="currency-toggle"
              onClick={() => setCurrency(currency === "ETH" ? "USD" : "ETH")}
              aria-label={`Display currency: ${currency}. Switch to ${currency === "ETH" ? "USD" : "ETH"}`}
            >
              {currency}
              <ChevronDown size={12} />
            </button>
          )}
        </div>
      </header>
      <div className="snapshot-banner">
        <span className="demo-tag">
          {onChain
            ? "ON-CHAIN DATA"
            : manifest.source === "demo"
              ? "DEMO SNAPSHOT"
              : "VERIFIED SNAPSHOT"}
        </span>
        <span>
          {onChain
            ? "Real events, bounded coverage. Demo rankings are separate."
            : manifest.source === "demo"
              ? "Explore with simulated data. No live market activity."
              : manifest.coverage}
        </span>
        <Link href={onChain ? "/methodology/" : "/live/"}>
          {onChain ? "About the demo" : "Explore real data"}{" "}
          <ArrowRight size={13} />
        </Link>
      </div>
      <main id="main">{children}</main>
      <footer className="footer">
        <span>Independent analytics. Not affiliated with Uniswap Labs.</span>
        <div>
          <span>
            {onChain
              ? "On-chain snapshot · coverage shown above"
              : "Demo snapshot · 14 Sep 2026, 06:00 UTC"}
          </span>
          <Link href="/methodology/">
            <BookOpen size={13} /> Methodology
          </Link>
        </div>
      </footer>
      <dialog
        ref={dialog}
        className="search-dialog"
        onClick={(e) => {
          if (e.target === dialog.current) close();
        }}
      >
        <div className="search-dialog-head">
          <Search size={20} />
          <input
            ref={input}
            name="global-search"
            aria-label="Search tokens, wallets, or transaction hashes"
            placeholder="Token, wallet, or transaction hash"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoComplete="off"
          />
          <button
            className="icon-button"
            onClick={close}
            aria-label="Close search"
          >
            <X size={20} />
          </button>
        </div>
        <div className="search-results">
          {loading && (
            <p role="status" className="search-hint">
              Loading transaction index…
            </p>
          )}
          {searchError && (
            <p role="status" className="search-hint">
              {searchError}
            </p>
          )}
          {!query && <p className="search-hint">Explore the snapshot</p>}
          {(["Token", "Wallet", "Transaction"] as const).map((type) => {
            const rows = matches.filter((r) => r.type === type).slice(0, 6);
            return rows.length ? (
              <section key={type}>
                <h2>{type === "Token" ? "Tokens" : `${type}s`}</h2>
                {rows.map((r) => (
                  <Link
                    key={r.subtitle}
                    href={r.href}
                    onClick={close}
                    className="search-result"
                  >
                    <span
                      className="search-result-icon"
                      style={{ color: r.color }}
                    >
                      {type === "Token" ? "◈" : type === "Wallet" ? "◉" : "↗"}
                    </span>
                    <span>
                      <strong>{r.title}</strong>
                      <small className="mono">{r.subtitle}</small>
                    </span>
                    <ArrowRight size={15} />
                  </Link>
                ))}
              </section>
            ) : null;
          })}
          {!matches.length && (
            <div className="empty-state">
              <h3>No matches in this snapshot</h3>
              <p>
                Try a token name, wallet label, or full transaction hash. ENS
                resolution is not available offline.
              </p>
              {/^0x[0-9a-fA-F]{40}$/.test(query.trim()) && (
                <Link
                  className="button"
                  onClick={close}
                  href={`/wallet/?address=${query.trim()}`}
                >
                  Look up address <ArrowRight size={14} />
                </Link>
              )}
            </div>
          )}
        </div>
        <div className="search-dialog-footer">
          <span>Search is limited to snapshot coverage</span>
          <kbd>esc to close</kbd>
        </div>
      </dialog>
    </>
  );
}
