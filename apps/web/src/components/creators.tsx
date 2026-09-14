"use client";
import Link from "next/link";
import { ArrowRight, ChevronRight, Info } from "lucide-react";
import type { Creator } from "@pools/core";
import {
  AddressLabel,
  Avatar,
  Change,
  ModeBadge,
  Money,
  TokenIcon,
} from "./ui";
export function Creators({ creators }: { creators: Creator[] }) {
  return (
    <div className="page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">FOLLOW THE BUILDERS</div>
          <h1>
            Creator profiles<span className="title-dot">.</span>
          </h1>
          <p>One address. Every launch. A wider view of who’s building.</p>
        </div>
        <span className="badge">{creators.length} creators in snapshot</span>
      </div>
      <div className="creator-grid">
        {creators.map((c) => (
          <section
            key={c.identity.address}
            id={c.identity.address}
            className="panel creator-card"
          >
            <div className="creator-card-head">
              <Avatar address={c.identity.address} color={c.identity.color} />
              <div>
                <h2>{c.identity.label}</h2>
                <AddressLabel address={c.identity.address} />
              </div>
              <span className="badge">{c.pools.length} launches</span>
            </div>
            <div className="creator-stat-row">
              <div>
                <small>Combined 7D volume</small>
                <strong>
                  <Money wei={c.volumeWei} />
                </strong>
              </div>
              <div>
                <small>Total snapshot liquidity</small>
                <strong>
                  <Money wei={c.liquidityWei} />
                </strong>
              </div>
            </div>
            <div className="creator-pools">
              {c.pools.map((p) => (
                <Link
                  className="creator-pool"
                  key={p.id}
                  href={`/pool/${p.id}/`}
                >
                  <div>
                    <TokenIcon pool={p} size="small" />
                    <strong>{p.name}</strong>
                    <ModeBadge mode={p.mode} />
                  </div>
                  <div>
                    <Change value={p.stats["7d"].change} />
                    <ChevronRight size={14} />
                  </div>
                </Link>
              ))}
            </div>
            <Link
              className="leader-link"
              style={{ margin: "18px -24px -24px" }}
              href={`/wallet/${c.identity.address}/`}
            >
              View trading profile <ArrowRight size={14} />
            </Link>
          </section>
        ))}
      </div>
      <div className="page-intro-note">
        <Info size={14} />
        <span>
          Creator identities and launch relationships are simulated. These
          profiles show activity, not a quality or safety score.
        </span>
      </div>
    </div>
  );
}
