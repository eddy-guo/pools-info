"use client";
import { useEffect, useRef, useState } from "react";
import { shortAddress, type LiveWindow } from "@pools/core";
import {
  cardPresets,
  cardQuery,
  cardUrl,
  defaultCardOptions,
  type CardOptions,
  type CardPreset,
} from "@/lib/card-options";
import styles from "./pnl-card-modal.module.css";

/** The card's geometry, as fractions of 1200 x 630, drawn while the PNG renders. */
const bones: [number, number, number, number][] = [
  [5.3, 7, 15, 5.6],
  [5.3, 17.5, 4.4, 8.3],
  [11.2, 18.4, 16, 4.4],
  [11.2, 24, 7, 2.6],
  [5.3, 34.5, 3.4, 6.4],
  [10, 35, 9, 5.2],
  [20, 35.4, 5.5, 4.4],
  [5.3, 51, 30, 16],
  [56, 18, 39, 51],
  [5.3, 73, 89.4, 13],
  [5.3, 90.6, 25, 3.4],
  [82.5, 90.6, 12, 3.4],
];
const twitter = (url: string) =>
  `https://twitter.com/intent/tweet?url=${encodeURIComponent(url)}`;

export function PnlCardModal({
  address,
  window: period,
  open,
  onClose,
}: {
  address: string;
  window: LiveWindow;
  open: boolean;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [preset, setPreset] = useState<CardPreset>(defaultCardOptions.preset);
  const [anonymous, setAnonymous] = useState(false);
  const [notional, setNotional] = useState(false);
  const [ready, setReady] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [sharing, setSharing] = useState(false);
  const options: CardOptions = { window: period, preset, anonymous, notional };
  const url = cardUrl(address, options);
  const state =
    failed === url
      ? "failed"
      : ready === url
        ? "ready"
        : ready
          ? "rendering"
          : "loading";
  const filename = anonymous
    ? `poolsinfo-pnl-${period.toLowerCase()}.png`
    : `poolsinfo-${address.toLowerCase()}-${period.toLowerCase()}.png`;
  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (open && !node.open) node.showModal();
    else if (!open && node.open) node.close();
    // The page behind a modal card must not scroll under it.
    document.body.style.overflow = open ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);
  /** The wallet page with the card's options, whose preview image is this very card. */
  const pageUrl = () =>
    new URL(
      `/wallet/${address.toLowerCase()}/?${cardQuery(options)}`,
      window.location.origin,
    ).href;
  const png = () =>
    fetch(url).then((response) => {
      if (!response.ok) throw Error("Card unavailable");
      return response.blob();
    });
  async function share() {
    setSharing(true);
    try {
      if (typeof navigator.share === "function") {
        const file = new File([await png()], filename, { type: "image/png" });
        if (navigator.canShare?.({ files: [file] })) {
          try {
            await navigator.share({ files: [file], title: "PnL card" });
          } catch (error) {
            // A dismissed share sheet is a choice, not a missing feature.
            if ((error as Error).name !== "AbortError") throw error;
          }
          return;
        }
      }
      throw Error("File sharing unsupported");
    } catch {
      window.open(twitter(pageUrl()), "_blank", "noopener,noreferrer");
    } finally {
      setSharing(false);
    }
  }
  async function copy() {
    const absolute = new URL(url, window.location.origin).href;
    try {
      if (typeof ClipboardItem === "undefined")
        throw Error("No image clipboard");
      try {
        // A promised blob keeps Safari's clipboard access inside the click.
        await navigator.clipboard.write([
          new ClipboardItem({ "image/png": png() }),
        ]);
      } catch {
        await navigator.clipboard.write([
          new ClipboardItem({ "image/png": await png() }),
        ]);
      }
      setCopied(true);
    } catch {
      try {
        await navigator.clipboard.writeText(absolute);
        setCopied(true);
      } catch {
        setCopied(false);
      }
    }
  }
  return (
    <dialog
      ref={dialog}
      className={styles.modal}
      aria-labelledby="pnl-card-title"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === dialog.current) onClose();
      }}
    >
      <div className={styles.head}>
        <h2 id="pnl-card-title">Share PnL card</h2>
        <button
          className="icon-button"
          aria-label="Close share card"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <div className={styles.body}>
        <div className={styles.customize}>
          <div>
            <h3>Customize</h3>
            <p>Choose a colour preset and what the card shows.</p>
          </div>
          <div className={styles.group}>
            <span className={styles.groupLabel} id="pnl-card-presets">
              Colour preset
            </span>
            <div
              className={styles.presets}
              role="radiogroup"
              aria-labelledby="pnl-card-presets"
            >
              {(Object.keys(cardPresets) as CardPreset[]).map((id) => (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={preset === id}
                  aria-label={cardPresets[id].label}
                  className={styles.swatch}
                  style={
                    { "--swatch": cardPresets[id].color } as React.CSSProperties
                  }
                  onClick={() => setPreset(id)}
                >
                  <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path
                      d="M3.5 8.5l3 3 6-6.5"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
              ))}
            </div>
          </div>
          <div className={styles.group}>
            <span className={styles.groupLabel}>Card settings</span>
            <div>
              <label className={styles.toggle}>
                <span>
                  <strong>Anonymous mode</strong>
                  <small>Hide the address, its identicon and the rank.</small>
                </span>
                <input
                  type="checkbox"
                  role="switch"
                  checked={anonymous}
                  onChange={(event) => setAnonymous(event.target.checked)}
                />
                <span className={styles.knob} aria-hidden="true" />
              </label>
              <label className={styles.toggle}>
                <span>
                  <strong>Show notional</strong>
                  <small>
                    Show the realized amount and traded volume in ETH.
                  </small>
                </span>
                <input
                  type="checkbox"
                  role="switch"
                  checked={notional}
                  onChange={(event) => setNotional(event.target.checked)}
                />
                <span className={styles.knob} aria-hidden="true" />
              </label>
            </div>
          </div>
          <div className={styles.actions}>
            <button
              className="button"
              disabled={state !== "ready" || sharing}
              onClick={share}
            >
              {sharing ? "Sharing…" : "Share"}
            </button>
            <button
              className="button secondary"
              disabled={state !== "ready"}
              onClick={copy}
            >
              {copied ? "Copied" : "Copy"}
            </button>
            <a
              className="button secondary"
              href={url}
              download={filename}
              aria-disabled={state !== "ready"}
            >
              Download
            </a>
          </div>
        </div>
        <div className={styles.stage}>
          <span className={styles.stageLabel}>Preview</span>
          <div className={styles.preview} data-state={state}>
            <div className={styles.skeleton} aria-hidden="true">
              {bones.map(([left, top, width, height], i) => (
                <span
                  key={i}
                  className={styles.bone}
                  style={{
                    left: `${left}%`,
                    top: `${top}%`,
                    width: `${width}%`,
                    height: `${height}%`,
                  }}
                />
              ))}
            </div>
            {open && (
              // The route renders every option server-side, so this preview and
              // the shared image are the same request.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={url}
                alt={`PnL card for ${anonymous ? "an anonymous wallet" : shortAddress(address)}, ${period} window`}
                width={1200}
                height={630}
                onLoad={() => setReady(url)}
                onError={() => setFailed(url)}
              />
            )}
            {state === "failed" && (
              <p className={styles.empty} role="status">
                No saved PnL to share for this window.
              </p>
            )}
          </div>
          <p className={styles.status} role="status">
            {state === "loading"
              ? "Rendering the card…"
              : state === "rendering"
                ? "Updating the card…"
                : "\u00a0"}
          </p>
        </div>
      </div>
    </dialog>
  );
}
