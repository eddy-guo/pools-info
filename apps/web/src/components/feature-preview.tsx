"use client";
import Link from "next/link";
import { useId, useRef, useState } from "react";
import styles from "./detail-design.module.css";
import { Wallet, X, LockKeyhole, ArrowUpRight } from "lucide-react";

const features = {
  connect: {
    title: "Your wallet. Your corner of Pools.",
    text: "Connect a wallet to bring your profile, rank and watchlist together.",
    notice:
      "Wallet connection is a UI preview. No wallet is connected and no signature is requested.",
    action: "Look up a public wallet",
    href: "/wallet/",
  },
  profile: {
    title: "Make your profile yours.",
    text: "A name, bio and avatar for your public trader profile.",
    notice:
      "Profile editing is a UI preview. Changes cannot be saved yet; we do not store account information.",
    action: "Browse wallet profiles",
    href: "/wallet/",
  },
  watchlist: {
    title: "Your watchlist, on every device.",
    text: "Keep the pools you follow together wherever you sign in.",
    notice:
      "Account sync is a UI preview. Stars work now and are saved only in this browser.",
    action: "Open this browser’s watchlist",
    href: "/?view=watchlist",
  },
  rank: {
    title: "Find your place on the board.",
    text: "Your wallet, performance and rank, one click away.",
    notice:
      "Personal rank is a UI preview. Wallet connection and a global ranking are not available yet. Existing rankings cover an audited pool.",
    action: "Look up your wallet",
    href: "/wallet/",
  },
  copy: {
    title: "Follow a trader’s next move.",
    text: "Mirror supported buys and sells using your own allocation. The controls preview the planned experience.",
    notice:
      "Copy trading is a UI preview. No trades, approvals or transactions can be submitted.",
    action: "Explore trader performance",
    href: "/traders/",
  },
} as const;
export function FeaturePreview({
  feature,
  children,
  className = "button secondary",
}: {
  feature: keyof typeof features;
  children: React.ReactNode;
  className?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  const f = features[feature];
  return (
    <>
      <button
        type="button"
        className={className}
        onClick={() => dialog.current?.showModal()}
      >
        {children}
      </button>
      <dialog
        ref={dialog}
        className="feature-dialog"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-notice`}
        onClick={(e) => {
          if (e.target === dialog.current) dialog.current?.close();
        }}
      >
        <div className="feature-dialog-top">
          <span className="preview-label">PRODUCT PREVIEW</span>
          <button
            className="icon-button"
            aria-label="Close preview"
            onClick={() => dialog.current?.close()}
          >
            <X size={20} />
          </button>
        </div>
        <div className="feature-icon">
          <Wallet size={26} />
        </div>
        <h2 id={`${id}-title`}>{f.title}</h2>
        <p>{f.text}</p>
        {feature === "connect" && (
          <div className="preview-options">
            <button disabled>
              MetaMask <span>Coming soon</span>
            </button>
            <button disabled>
              WalletConnect <span>Coming soon</span>
            </button>
          </div>
        )}
        {feature === "profile" && (
          <fieldset disabled className="preview-profile">
            <legend>Profile editor preview</legend>
            <label>
              Display name
              <input placeholder="Your display name" />
            </label>
            <label>
              Bio
              <textarea
                placeholder="Tell other traders about yourself"
                rows={2}
              />
            </label>
            <button className="button" disabled>
              Save profile
            </button>
          </fieldset>
        )}
        <div className="preview-notice" id={`${id}-notice`}>
          <LockKeyhole size={17} />
          <span>{f.notice}</span>
        </div>
        <Link
          className="button"
          href={f.href}
          onClick={() => dialog.current?.close()}
        >
          {f.action}
          <ArrowUpRight size={15} />
        </Link>
      </dialog>
    </>
  );
}
export function PersonalRankPreview() {
  return (
    <div className="personal-rank">
      <div>
        <span className="eyebrow">YOUR PLACE ON THE BOARD</span>
        <strong>
          Connect to see your rank{" "}
          <span className="preview-label">Preview</span>
        </strong>
        <small>
          Wallet profiles are public. Personal ranking is coming later.
        </small>
      </div>
      <FeaturePreview feature="rank">View my rank</FeaturePreview>
    </div>
  );
}

/** Interactive design controls only; no orders, signatures or subscriptions. */
export function TradingPreviewPanels() {
  const [size, setSize] = useState("0.1 ETH");
  const [alerts, setAlerts] = useState<string[]>([]);
  return (
    <>
      <section className={`panel ${styles.copyPanel}`}>
        <div className="panel-heading">
          <h2>Copy trading</h2>
          <span className={styles.preview}>PREVIEW</span>
        </div>
        <div className={styles.copyBody}>
          <p>
            Follow this wallet’s buys and sells, sized to your own allocation.
          </p>
          <span>Per trade</span>
          <div className="segmented" aria-label="Copy trade size preview">
            {["0.05 ETH", "0.1 ETH", "0.5 ETH"].map((v) => (
              <button
                key={v}
                aria-pressed={size === v}
                onClick={() => setSize(v)}
              >
                {v}
              </button>
            ))}
          </div>
          <div className={styles.rules}>
            {[
              "Mirror sells",
              "Skip first-block entries",
              "Skip tokens already held",
            ].map((label) => (
              <label key={label}>
                <input type="checkbox" defaultChecked />
                {label}
              </label>
            ))}
          </div>
          <FeaturePreview feature="copy" className="button">
            Set up copy trading
          </FeaturePreview>
          <p style={{ marginTop: 12, marginBottom: 0 }}>
            Preview only. These settings do not submit orders or connect a
            wallet. No returns or execution lag are estimated.
          </p>
        </div>
      </section>
      <section className="panel">
        <div className="panel-heading">
          <h2>Alerts</h2>
          <span className={styles.preview}>PREVIEW</span>
        </div>
        {[
          ["New trade", "When this wallet buys or sells"],
          ["New launch", "When this wallet launches a pool"],
          ["Position closed", "When their inventory returns to zero"],
        ].map(([label, note]) => (
          <button
            className={styles.alert}
            key={label}
            aria-pressed={alerts.includes(label)}
            onClick={() =>
              setAlerts((p) =>
                p.includes(label)
                  ? p.filter((v) => v !== label)
                  : [...p, label],
              )
            }
          >
            <span>
              {label}
              <small>{note}</small>
            </span>
            <span className={styles.switch} aria-hidden="true" />
          </button>
        ))}
        <p className="panel-footnote">
          Controls preview the experience. Notifications are not delivered or
          saved.
        </p>
      </section>
    </>
  );
}
