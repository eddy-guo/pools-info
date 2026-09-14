"use client";
import Link from "next/link";
import { useId, useRef } from "react";
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
    text: "Copy trading is part of the planned product. Its controls and execution will be defined in a later iteration.",
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
