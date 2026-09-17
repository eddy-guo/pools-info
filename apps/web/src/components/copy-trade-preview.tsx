"use client";
import { useEffect, useRef } from "react";
import styles from "./copy-trade-preview.module.css";

/** The design's per-trade sizes in ETH; 0.10 is its default selection. */
const sizes = ["0.05", "0.10", "0.25", "1.00"];
const rules: [string, boolean][] = [
  ["Skip holds under 60 seconds", true],
  ["Skip pools under 10 ETH liquidity", true],
  ["Include crowd-auction entries", false],
];

/**
 * The design's copy-trading card, opened from the wallet header as a modal.
 * Every control keeps the card's shape and none of them does anything: there
 * is no wallet connection, no order and no backtest behind it yet.
 */
export function CopyTradePreview({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (open && !node.open) node.showModal();
    else if (!open && node.open) node.close();
  }, [open]);
  return (
    <dialog
      ref={dialog}
      className={styles.modal}
      aria-labelledby="copy-trade-title"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === dialog.current) onClose();
      }}
    >
      <div className={styles.head}>
        <h2 id="copy-trade-title">Copy trading</h2>
        <div className={styles.controls}>
          <button
            type="button"
            role="switch"
            aria-checked="false"
            aria-label="Copy trading"
            className={styles.switch}
            disabled
          >
            <span className={styles.track} />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Close copy trading preview"
            onClick={onClose}
          >
            ×
          </button>
        </div>
      </div>
      <div className={styles.body}>
        <p className={styles.lede}>
          Mirror every buy this wallet makes, sized to your own allocation.
          Sells mirror too.
        </p>
        <span className={styles.label} id="copy-trade-size">
          Per trade
        </span>
        <div
          className={`segmented ${styles.sizes}`}
          role="group"
          aria-labelledby="copy-trade-size"
        >
          {sizes.map((size) => (
            <button
              key={size}
              type="button"
              aria-pressed={size === "0.10"}
              disabled
            >
              {size}
            </button>
          ))}
        </div>
        <div className={styles.rules}>
          {rules.map(([label, checked]) => (
            <label key={label}>
              <input
                type="checkbox"
                className={styles.check}
                defaultChecked={checked}
                disabled
              />
              <span className={styles.box} aria-hidden="true">
                <svg viewBox="0 0 16 16" fill="none">
                  <path
                    d="M3.5 8.5l3 3 6-6.5"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
              {label}
            </label>
          ))}
        </div>
        {/* The value stays empty until a backtest exists to fill it. */}
        <div className={styles.estimate}>
          <span>Their last 30d, at your size</span>
          <strong className="number" />
        </div>
        <p className={styles.state} role="status">
          Copy trading is not available yet.
        </p>
      </div>
    </dialog>
  );
}
