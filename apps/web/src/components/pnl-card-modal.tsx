"use client";
import { useEffect, useRef, useState } from "react";
import {
  shortAddress,
  type AnalyticsWalletResponse,
  type LiveWindow,
} from "@pools/core";
import { fetchProduct } from "@/lib/use-product";
import {
  cardDesigns,
  cardPresets,
  cardQuery,
  cardUrl,
  defaultCardOptions,
  type CardDesign,
  type CardOptions,
  type CardPreset,
} from "@/lib/card-options";
import styles from "./pnl-card-modal.module.css";
import { useCardDesign } from "./card-design";

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

/**
 * The position a card opens on. A wallet row has already read the position
 * as supported, so its card renders at once; the pool page has not read the
 * wallet, so its position stays unconfirmed until the modal's own read finds
 * it among the wallet's supported positions.
 */
export interface CardScope {
  poolId: string;
  launchTx: string;
  symbol: string;
  token: string;
  supported: boolean;
}
type CardKind = "position" | "portfolio";
const cardKinds: Record<CardKind, string> = {
  position: "Position",
  portfolio: "Portfolio",
};
type ListedPosition = Omit<CardScope, "supported">;
/**
 * The wallet's supported positions, the only ones with a card, largest
 * lifetime realized first; read once per opening of a position card, from
 * the same All read the card route draws them from.
 */
function useCardPositions(address: string, enabled: boolean) {
  const [state, setState] = useState<{
    address: string;
    positions?: ListedPosition[];
    truncated?: boolean;
    error?: string;
  }>({ address });
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    fetchProduct<AnalyticsWalletResponse>(
      `wallets/${address}?window=All`,
      controller.signal,
    ).then(
      (data) =>
        setState({
          address,
          positions: data.positions
            .flatMap((p) =>
              p.supported && p.position
                ? [{ row: p, realized: BigInt(p.position.realizedWei ?? "0") }]
                : [],
            )
            .sort((a, b) =>
              a.realized === b.realized ? 0 : a.realized > b.realized ? -1 : 1,
            )
            .map(({ row }) => ({
              poolId: row.poolId.toLowerCase(),
              launchTx: row.launchTx.toLowerCase(),
              symbol: row.symbol,
              token: row.token,
            })),
          truncated: !!data.positionsTruncated,
        }),
      (error: Error) => {
        if (!controller.signal.aborted)
          setState({ address, error: error.message });
      },
    );
    return () => controller.abort();
  }, [address, enabled]);
  return state.address === address ? state : { address };
}
/** A file name piece from a token symbol: letters and digits only. */
const fileSlug = (symbol: string) =>
  symbol
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "position";

export function PnlCardModal({
  address,
  window: period,
  open,
  onClose,
  scope = null,
}: {
  address: string;
  window: LiveWindow;
  open: boolean;
  onClose: () => void;
  /** Opens on this position's card; null opens on the portfolio card. */
  scope?: CardScope | null;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  /* Each opening starts on the card it was opened for: a row's position, or
     the portfolio. Corrected during render, keyed on the scope's pool rather
     than its object, so a caller that rebuilds the scope each render does
     not reset the choice. */
  const opening = `${open}:${scope?.poolId ?? ""}`;
  const [openedFor, setOpenedFor] = useState(opening);
  const [kind, setKind] = useState<CardKind>(scope ? "position" : "portfolio");
  const [picked, setPicked] = useState<string | null>(scope?.poolId ?? null);
  if (openedFor !== opening) {
    setOpenedFor(opening);
    if (open) {
      setKind(scope ? "position" : "portfolio");
      setPicked(scope?.poolId ?? null);
    }
  }
  const listing = useCardPositions(
    address.toLowerCase(),
    open && kind === "position",
  );
  const listed = listing.positions;
  /* The position the card draws: the one picked if the wallet's read lists
     it as supported, else the largest. Until the read answers (or if it
     cannot be read in full) only a row's own position is drawn, which that
     row already read as supported; the pool page's position waits for it. */
  const trusted = scope?.supported && scope.poolId === picked ? scope : null;
  const target: ListedPosition | null =
    kind !== "position"
      ? null
      : listed
        ? (listed.find((p) => p.poolId === picked) ??
          (picked === null
            ? (listed[0] ?? null)
            : listing.truncated && scope?.poolId === picked
              ? scope
              : null))
        : trusted;
  const positionNotice =
    kind !== "position" || target
      ? null
      : listing.error
        ? listing.error
        : !listed
          ? null
          : picked !== null
            ? "No supported position in this pool for your wallet."
            : "No supported position to share for this wallet.";
  const choices = listed ?? (trusted ? [trusted] : []);
  const [preset, setPreset] = useState<CardPreset>(defaultCardOptions.preset);
  const { design, setDesign: chooseDesign } = useCardDesign();
  const [anonymous, setAnonymous] = useState(false);
  const [notional, setNotional] = useState(false);
  const [ready, setReady] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [sharing, setSharing] = useState(false);
  /* The notional toggle is offered disabled, with its reason, on a design
     that does not honour it; the choice is kept for the designs that do. */
  const notionalOffered = kind === "portfolio" && cardDesigns[design].notional;
  const options: CardOptions = {
    window: period,
    preset,
    design,
    anonymous,
    notional: notional && notionalOffered,
  };
  /* A position card is one history in one pool, so its URL names the pool
     and its launch instead of a window. */
  const pool = target
    ? { pool: target.poolId, launch: target.launchTx }
    : undefined;
  const url =
    kind === "portfolio"
      ? cardUrl(address, options)
      : pool
        ? cardUrl(address, options, pool)
        : null;
  const state = positionNotice
    ? "unavailable"
    : url === null
      ? "loading"
      : failed === url
        ? "failed"
        : ready === url
          ? "ready"
          : ready
            ? "rendering"
            : "loading";
  const subject = target ? fileSlug(target.symbol) : period.toLowerCase();
  const filename = anonymous
    ? `poolsinfo-pnl-${subject}.png`
    : `poolsinfo-${address.toLowerCase()}-${subject}.png`;
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
      `/wallet/${address.toLowerCase()}/?${cardQuery(options, pool)}`,
      window.location.origin,
    ).href;
  const png = () =>
    fetch(url!).then((response) => {
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
    const absolute = new URL(url!, window.location.origin).href;
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
            <p>Choose a card, a colour preset and what the card shows.</p>
          </div>
          <div className={styles.group}>
            <span className={styles.groupLabel} id="pnl-card-kind">
              Card
            </span>
            <div
              className="segmented"
              role="group"
              aria-labelledby="pnl-card-kind"
            >
              {(Object.keys(cardKinds) as CardKind[]).map((id) => (
                <button
                  key={id}
                  type="button"
                  aria-pressed={kind === id}
                  className={kind === id ? "selected" : ""}
                  onClick={() => setKind(id)}
                >
                  {cardKinds[id]}
                </button>
              ))}
            </div>
          </div>
          <div className={styles.group}>
            {/* A position card has one design: the choice is kept for the
                portfolio card and offered disabled here, its reason on the
                label's own line so the column keeps its height. */}
            <span className={styles.groupLabel}>
              <span id="pnl-card-design">Design</span>
              {kind === "position" && (
                <span id="pnl-card-design-note">
                  {" "}
                  · {cardDesigns[defaultCardOptions.design].label} only for
                  positions
                </span>
              )}
            </span>
            <div
              className="segmented"
              role="group"
              aria-labelledby="pnl-card-design"
              aria-describedby={
                kind === "position" ? "pnl-card-design-note" : undefined
              }
            >
              {(Object.keys(cardDesigns) as CardDesign[]).map((id) => {
                const shown =
                  kind === "position"
                    ? id === defaultCardOptions.design
                    : design === id;
                return (
                  <button
                    key={id}
                    type="button"
                    aria-pressed={shown}
                    className={shown ? "selected" : ""}
                    disabled={kind === "position"}
                    onClick={() => chooseDesign(id)}
                  >
                    {cardDesigns[id].label}
                  </button>
                );
              })}
            </div>
          </div>
          <div className={styles.group}>
            <span className={styles.groupLabel} id="pnl-card-presets">
              Colour preset
            </span>
            {/* One tab stop, on the checked swatch; the arrow keys move the
                choice and the focus together, as a radio group does. */}
            <div
              className={styles.presets}
              role="radiogroup"
              aria-labelledby="pnl-card-presets"
              onKeyDown={(event) => {
                const ids = Object.keys(cardPresets) as CardPreset[];
                const at = ids.indexOf(preset);
                const step =
                  event.key === "ArrowRight" || event.key === "ArrowDown"
                    ? 1
                    : event.key === "ArrowLeft" || event.key === "ArrowUp"
                      ? -1
                      : null;
                const next =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? ids.length - 1
                      : step === null
                        ? null
                        : (at + step + ids.length) % ids.length;
                if (next === null) return;
                event.preventDefault();
                setPreset(ids[next]);
                event.currentTarget
                  .querySelectorAll<HTMLElement>('[role="radio"]')
                  [next]?.focus();
              }}
            >
              {(Object.keys(cardPresets) as CardPreset[]).map((id) => (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={preset === id}
                  aria-label={cardPresets[id].label}
                  tabIndex={preset === id ? 0 : -1}
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
              <label className={styles.toggle} aria-disabled={!notionalOffered}>
                <span>
                  <strong>Show notional</strong>
                  <small>
                    {notionalOffered
                      ? "Show the realized amount and traded volume in ETH."
                      : kind === "position"
                        ? "Not offered on a position card: it always shows the ETH in and out."
                        : `Not offered on the ${cardDesigns[design].label} design: its headline is already the realized amount in ETH.`}
                  </small>
                </span>
                <input
                  type="checkbox"
                  role="switch"
                  checked={notional && notionalOffered}
                  disabled={!notionalOffered}
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
            {/* A link is only a link once the card it names is ready; until
                then it is a disabled button, out of the tab order. */}
            {state === "ready" && url ? (
              <a className="button secondary" href={url} download={filename}>
                Download
              </a>
            ) : (
              <button className="button secondary" disabled>
                Download
              </button>
            )}
          </div>
        </div>
        <div className={styles.stage}>
          <div className={styles.stageHead}>
            {kind === "portfolio" ? (
              <span className={styles.stageLabel}>
                Preview · {period} realized
              </span>
            ) : (
              <>
                <label
                  className={styles.stageLabel}
                  htmlFor="pnl-card-position"
                >
                  Preview · Position
                </label>
                <select
                  id="pnl-card-position"
                  className={styles.position}
                  value={target?.poolId ?? ""}
                  disabled={!choices.length}
                  onChange={(event) => setPicked(event.target.value)}
                >
                  {!target && (
                    <option value="" disabled>
                      {listed || listing.error
                        ? "No position"
                        : "Loading positions…"}
                    </option>
                  )}
                  {choices.map((p) => (
                    <option key={p.poolId} value={p.poolId}>
                      {p.symbol} · {shortAddress(p.token)}
                    </option>
                  ))}
                </select>
              </>
            )}
          </div>
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
            {open && url && (
              // The route renders every option server-side, so this preview and
              // the shared image are the same request.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={url}
                alt={
                  target
                    ? `PnL card for ${anonymous ? "an anonymous wallet" : shortAddress(address)}'s ${target.symbol} position`
                    : `PnL card for ${anonymous ? "an anonymous wallet" : shortAddress(address)}, ${period} window`
                }
                width={1200}
                height={630}
                onLoad={() => setReady(url)}
                onError={() => setFailed(url)}
              />
            )}
            {(state === "failed" || state === "unavailable") && (
              <p className={styles.empty} role="status">
                {positionNotice ??
                  (target
                    ? "The card for this position could not be rendered."
                    : "No saved PnL to share for this window.")}
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
