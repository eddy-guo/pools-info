"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { formatMoney } from "@pools/core";
import { Search } from "./search";
import { UnitToggle } from "./unit-toggle";
import { useEthPrice } from "./eth-price-provider";
import { WalletProfileEntry } from "./wallet-profile";

const oneEthWei = (10n ** 18n).toString();

export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const usdPerEth = useEthPrice();
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
            <WalletProfileEntry />
          </div>
        </div>
        <div className="network-subnav">
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
        {/* lightweight-charts' attribution notice (its NOTICE file, verbatim)
            with the link its README requires on a page users see; the on-chart
            logo in candles.tsx is off in its place. */}
        <p className="footer-credit">
          TradingView Lightweight Charts™ Copyright (c) 2025 TradingView, Inc.{" "}
          <a
            href="https://www.tradingview.com/"
            target="_blank"
            rel="noreferrer"
          >
            https://www.tradingview.com/
          </a>
        </p>
      </footer>
    </div>
  );
}
