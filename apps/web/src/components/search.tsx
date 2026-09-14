"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Command, Search as SearchIcon, X } from "lucide-react";
import { poolHref, shortAddress, walletHref } from "@pools/core";
import { useLive } from "./live-provider";
import { explorer } from "./live-ui";
export function Search() {
  const { snapshot: s, audits } = useLive();
  const dialog = useRef<HTMLDialogElement>(null),
    input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  function open() {
    dialog.current?.showModal();
    input.current?.focus();
  }
  function close() {
    dialog.current?.close();
    setQuery("");
  }
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        open();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
  const q = query.trim().toLowerCase();
  const rows: {
    type: string;
    title: string;
    subtitle: string;
    href: string;
    external?: boolean;
  }[] = [
    ...s.markets.map((m) => ({
      type: "Tokens",
      title: `${m.name} (${m.symbol})`,
      subtitle: m.token,
      href: poolHref(m),
    })),
    ...[...new Set(s.markets.map((m) => m.launchSender.toLowerCase()))].map(
      (a) => ({
        type: "Creators",
        title: shortAddress(a),
        subtitle: `${a} · launch sender`,
        href: `/creators/${a}/`,
      }),
    ),
    ...Object.values(audits).flatMap((a) =>
      a.wallets.map((w) => ({
        type: "Wallets",
        title: shortAddress(w.address),
        subtitle: `${w.address} · audited in ${a.market.symbol}`,
        href: walletHref(w.address, a.market),
      })),
    ),
    ...s.trades.map((t) => ({
      type: "Transactions",
      title: `${t.side} · ${s.markets.find((m) => m.id === t.poolId)?.symbol}`,
      subtitle: t.txHash,
      href: `${explorer}/tx/${t.txHash}`,
      external: true,
    })),
  ];
  const matches = rows
    .filter((r) => `${r.title} ${r.subtitle}`.toLowerCase().includes(q))
    .filter(
      (r, i, all) =>
        all.findIndex((p) => p.href === r.href && p.type === r.type) === i,
    );
  if (/^0x[0-9a-f]{40}$/.test(q) && !matches.some((r) => r.type === "Wallets"))
    matches.push({
      type: "Wallets",
      title: shortAddress(q),
      subtitle: "Look up this address · coverage is checked on the wallet page",
      href: walletHref(q),
    });
  if (
    /^0x[0-9a-f]{64}$/.test(q) &&
    !matches.some((r) => r.type === "Transactions")
  )
    matches.push({
      type: "Transactions",
      title: shortAddress(q),
      subtitle: "Outside the sample · open transaction on explorer",
      href: `${explorer}/tx/${q}`,
      external: true,
    });
  const ens = /^[\w.-]+\.eth$/.test(q);
  return (
    <>
      <button
        className="search-trigger"
        aria-label="Search tokens, wallets, creators, transactions"
        onClick={open}
      >
        <SearchIcon size={16} />
        <span>Search tokens, wallets…</span>
        <kbd>
          <Command size={11} /> K
        </kbd>
      </button>
      <dialog
        ref={dialog}
        className="search-dialog"
        onClick={(e) => {
          if (e.target === dialog.current) close();
        }}
      >
        <div className="search-dialog-head">
          <SearchIcon size={20} />
          <input
            ref={input}
            name="global-search"
            aria-label="Search tokens, wallets, creators, or transaction hashes"
            placeholder="Token, address, ENS or transaction"
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
          <p className="search-hint">
            {ens
              ? "ENS name detected. Resolution is not connected yet; enter the wallet address."
              : "Search currently covered tokens, launch senders, audited wallets, and transactions."}
          </p>
          {["Tokens", "Wallets", "Creators", "Transactions"].map((type) => {
            const selected = matches.filter((r) => r.type === type).slice(0, 5);
            return selected.length ? (
              <section key={type}>
                <h2>{type}</h2>
                {selected.map((r) => (
                  <Link
                    className="search-result"
                    key={r.href}
                    href={r.href}
                    onClick={close}
                    target={r.external ? "_blank" : undefined}
                    rel={r.external ? "noreferrer" : undefined}
                  >
                    <span>
                      <strong>{r.title}</strong>
                      <small className="mono">{r.subtitle}</small>
                    </span>
                  </Link>
                ))}
              </section>
            ) : null;
          })}
          {!matches.length && !ens && (
            <div className="empty-state">
              <h3>No matches in current coverage</h3>
              <p>Try a token symbol or full address.</p>
            </div>
          )}
        </div>
        <div className="search-dialog-footer">
          Addresses: 42 characters · Transaction hashes: 66 characters · Esc to
          close
        </div>
      </dialog>
    </>
  );
}
