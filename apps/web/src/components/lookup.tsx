"use client";
import Link from "next/link";
import { useState } from "react";
import { ArrowRight } from "lucide-react";
import type { Identity } from "@pools/core";
import { useQuery } from "./state";
import { Avatar, EmptyState } from "./ui";
export function WalletLookup({ wallets }: { wallets: Identity[] }) {
  const { params, set } = useQuery();
  const [value, setValue] = useState("");
  const submitted = params.get("address");
  const match = wallets.find(
    (w) => w.address.toLowerCase() === submitted?.toLowerCase(),
  );
  return (
    <div className="page lookup">
      <div className="page-heading">
        <div>
          <div className="eyebrow">PUBLIC PROFILES / NO CONNECTION NEEDED</div>
          <h1>
            Look up a wallet<span className="title-dot">.</span>
          </h1>
          <p>Paste an address to check its coverage in this snapshot.</p>
        </div>
      </div>
      <form
        className="lookup-form"
        onSubmit={(e) => {
          e.preventDefault();
          set({ address: value.trim() });
        }}
      >
        <input
          name="wallet-address"
          aria-label="Wallet address"
          placeholder="0x…"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          pattern="0x[0-9a-fA-F]{40}"
          required
          title="Enter a full Ethereum-style address: 0x followed by 40 hexadecimal characters"
        />
        <button className="button" type="submit">
          Look up <ArrowRight size={14} />
        </button>
      </form>
      {submitted && !match && (
        <div className="panel">
          <EmptyState
            title="Outside this snapshot"
            description="This address has no profile in the current dataset. That does not mean the wallet has no activity. Live address coverage will come with indexing."
          />
        </div>
      )}
      {match && (
        <Link
          className="panel search-result"
          href={`/wallet/${match.address}/`}
        >
          <Avatar address={match.address} color={match.color} />
          <span>
            <strong>{match.label}</strong>
            <small>Profile available in the demo snapshot</small>
          </span>
          <ArrowRight size={15} />
        </Link>
      )}
      <h2 style={{ fontSize: 14, margin: "30px 0 12px" }}>
        Or explore a demo wallet
      </h2>
      {wallets.slice(0, 4).map((w) => (
        <Link
          className="search-result"
          key={w.address}
          href={`/wallet/${w.address}/`}
        >
          <Avatar address={w.address} color={w.color} />
          <span>
            <strong>{w.label}</strong>
            <small className="mono">{w.address}</small>
          </span>
          <ArrowRight size={14} />
        </Link>
      ))}
    </div>
  );
}
