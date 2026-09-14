"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowRight, BookOpen } from "lucide-react";
import { FeaturePreview } from "./feature-preview";
import { Search } from "./search";
import { Freshness } from "./live-provider";

export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
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
          {[
            { label: "Explore", href: "/" },
            { label: "Traders", href: "/traders/" },
            { label: "Creators", href: "/creators/" },
            { label: "Wallet", href: "/wallet/" },
            { label: "Methodology", href: "/methodology/" },
          ].map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={pathname === item.href ? "active" : ""}
              aria-current={pathname === item.href ? "page" : undefined}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="header-actions">
          <Search />
          <FeaturePreview feature="connect" className="button connect-button">
            Connect wallet
          </FeaturePreview>
          <span className="network-badge">
            <span className="network-mark">R</span>
            <span>Robinhood</span>
          </span>
        </div>
      </header>
      <div className="snapshot-banner">
        <span className="demo-tag">ON-CHAIN DATA</span>
        <span>
          Recent instant launches. Coverage and capture time shown with the
          data.
        </span>
        <Link href="/methodology/">
          Sources and limits <ArrowRight size={13} />
        </Link>
      </div>
      <Freshness />
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
    </>
  );
}
