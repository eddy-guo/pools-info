"use client";
import Link from "next/link";
import styles from "./detail-design.module.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { Command, Search as SearchIcon, ArrowUpRight } from "lucide-react";
import {
  searchGroups,
  shortAddress,
  type SearchResponse,
} from "@pools/core";
import { createSearchProvider } from "@/lib/search-provider";
import { Avatar } from "./ui";
import { SearchSkeleton } from "./skeletons";
import { useLive } from "./live-provider";
const kindHints: Record<SearchResponse["kind"], string> = {
  text: "name",
  address: "address",
  hash: "tx hash",
  ens: "ens",
};
export function Search() {
  const { snapshot, audits } = useLive();
  const provider = useMemo(
    () => createSearchProvider(snapshot, audits),
    [snapshot, audits],
  );
  const dialog = useRef<HTMLDialogElement>(null),
    input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [isOpen, setOpen] = useState(false);
  const [ready, setReady] = useState(false);
  const [result, setResult] = useState<{
    query: string;
    provider: typeof provider;
    data?: SearchResponse & { indexNotice?: string };
    error?: string;
    pending?: boolean;
  }>();
  const current =
    result?.query === query && result?.provider === provider
      ? result
      : undefined;
  const data = current?.data;
  const waiting =
    isOpen &&
    (!current ||
      (!current.error && (!data || (!data.entries.length && current.pending))));
  const kindHint = query.trim() && data?.kind ? kindHints[data.kind] : undefined;
  function open() {
    if (!dialog.current?.open) dialog.current?.showModal();
    setOpen(true);
    input.current?.focus();
  }
  function close() {
    dialog.current?.close();
  }
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (dialog.current?.open) dialog.current.close();
        else {
          dialog.current?.showModal();
          setOpen(true);
          input.current?.focus();
        }
      }
    };
    window.addEventListener("keydown", handler);
    const frame = requestAnimationFrame(() => setReady(true));
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("keydown", handler);
    };
  }, []);
  useEffect(() => {
    if (!isOpen) return;
    const controller = new AbortController();
    const timer = setTimeout(
      () => {
        provider
          .search(query, { signal: controller.signal })
          .then(async (data) => {
            if (controller.signal.aborted) return;
            setResult({ query, provider, data, pending: true });
            const extended = await provider.extend(
              query,
              { signal: controller.signal },
              data,
            );
            if (!controller.signal.aborted)
              setResult({
                query,
                provider,
                data: extended,
                pending: false,
              });
          })
          .catch(() => {
            if (!controller.signal.aborted)
              setResult((previous) => ({
                query,
                provider,
                data:
                  previous?.query === query && previous?.provider === provider
                    ? previous.data
                    : undefined,
                pending: false,
                error: "Search is unavailable. Try again shortly.",
              }));
          });
      },
      query ? 100 : 0,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, provider, isOpen]);
  return (
    <>
      <button
        className="search-trigger"
        disabled={!ready}
        aria-keyshortcuts="Meta+K Control+K"
        aria-label="Search tokens, wallets, creators, transactions"
        onClick={open}
      >
        <SearchIcon size={16} />
        <span>Search anything…</span>
        <kbd>
          <Command size={11} /> K
        </kbd>
      </button>
      <dialog
        ref={dialog}
        className={`search-dialog ${styles.search}`}
        aria-label="Search Pools Info"
        onClose={() => {
          setOpen(false);
          setQuery("");
        }}
        onClick={(e) => {
          if (e.target === dialog.current) close();
        }}
        onKeyDown={(e) => {
          if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
          const rows = [
            ...(dialog.current?.querySelectorAll<HTMLAnchorElement>(
              ".search-result",
            ) ?? []),
          ];
          if (
            !rows.length ||
            (e.target !== input.current &&
              !rows.includes(e.target as HTMLAnchorElement))
          )
            return;
          e.preventDefault();
          const index = rows.indexOf(
            document.activeElement as HTMLAnchorElement,
          );
          if (index === 0 && e.key === "ArrowUp") input.current?.focus();
          else
            rows[
              index < 0
                ? e.key === "ArrowDown"
                  ? 0
                  : rows.length - 1
                : (index + (e.key === "ArrowDown" ? 1 : -1) + rows.length) %
                  rows.length
            ]?.focus();
        }}
      >
        <div className="search-dialog-head">
          <SearchIcon size={18} />
          <input
            ref={input}
            name="global-search"
            aria-label="Search tokens, wallets, creators, or transaction hashes"
            placeholder="Token, wallet, transaction, or name.eth"
            value={query}
            maxLength={256}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                dialog.current
                  ?.querySelector<HTMLAnchorElement>(".search-result")
                  ?.click();
              }
            }}
            autoComplete="off"
            spellCheck={false}
          />
          {kindHint && <span className="search-kind-hint">{kindHint}</span>}
        </div>
        <div className="search-results" aria-busy={Boolean(waiting)}>
          {data?.indexNotice && (
            <p className="search-help">{data.indexNotice}</p>
          )}
          {!query && (
            <p className="search-help">
              Try a name or a typo, paste an address, or use <code>token:</code>
              , <code>wallet:</code>, <code>creator:</code>, <code>tx:</code>.
            </p>
          )}
          <span className="sr-only" role="status">
            {current?.error ?? (data ? `${data.total} results` : "Searching")}
          </span>
          {waiting && <SearchSkeleton />}
          {data?.kind === "ens" && !data.entries.length && (
            <div className="search-explainer">
              <span className="preview-label">ENS LOOKUP</span>
              <h3>ENS name detected</h3>
              <p>
                {data.message ??
                  "No matching records in this category. Try All or paste the wallet address."}
              </p>
              <small>
                ENS lookup uses Ethereum RPC. This does not establish trading
                activity on Robinhood.
              </small>
            </div>
          )}
          {searchGroups.map((type) => {
            const selected =
              data?.entries.filter((r) => r.group === type) ?? [];
            return selected.length ? (
              <section key={type}>
                <h2>{type}</h2>
                {selected.map((r) => {
                  const title = r.title.replace(
                    /^(.*) \(([^()]+)\)$/,
                    "$1 · $2",
                  );
                  const address = shortAddress(r.address);
                  return (
                    <Link
                      className="search-result"
                      key={r.id}
                      href={r.href}
                      prefetch={false}
                      onClick={close}
                      target={r.external ? "_blank" : undefined}
                      rel={r.external ? "noreferrer" : undefined}
                    >
                      <Avatar address={r.address} />
                      <span className="search-result-copy">
                        <strong>{title}</strong>
                        {address !== title && (
                          <small className="mono">{address}</small>
                        )}
                      </span>
                      {r.external && <ArrowUpRight size={15} />}
                    </Link>
                  );
                })}
              </section>
            ) : null;
          })}
          {data &&
            !data.entries.length &&
            data.kind !== "ens" &&
            !current?.pending && (
              <div className="empty-state">
                <h3>No matches</h3>
                <p>
                  This does not mean the token or wallet does not exist. Try its
                  full address or a shorter name.
                </p>
              </div>
            )}
          {current?.error && (
            <p role="alert" className="search-help">
              {current.error}
            </p>
          )}
        </div>
        <div className="search-dialog-footer">
          <span>↑ ↓ Navigate · Enter Open · Esc Close</span>
        </div>
      </dialog>
    </>
  );
}
