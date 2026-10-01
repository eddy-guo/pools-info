import { ImageResponse } from "next/og";
import type { CSSProperties, ReactElement } from "react";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import {
  cardCurve,
  cardEthFigure,
  cardExportHero,
  cardExportHeroSize,
  cardExportTrio,
  cardHero,
  cardInitials,
  cardLineSize,
  cardMoney,
  cardMoneyText,
  cardStats,
  cardSymbol,
  cardTopPosition,
  cardTradeCount,
  cardUsdPerEth,
  positionCardChart,
  positionCardFigures,
  readCardPosition,
  readCardWallet,
  type CardEth,
  type CardMoney,
  type CardPosition,
  type PositionCardFigures,
  type CardExportTrio,
  type CardStat,
} from "@/lib/product-card";
import {
  cardPresets,
  cardWindowLabel,
  parseCardOptions,
} from "@/lib/card-options";
import { countLabel } from "@/lib/plural";
import { tokenInitials } from "@/lib/token-identity";
import { fontAdvances, fontCodePoints } from "@/lib/font-coverage";
import { tokenImageResponse } from "@/lib/token-image-server";
import {
  identityTint,
  shortAddress,
  visualTheme,
  type LiveWindow,
} from "@pools/core";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// The renderer takes TTF, not the site's WOFF2, so the card reads the static
// faces once per process (apps/web/public/fonts/SOURCE.txt).
const face = (file: string) =>
  readFile(join(process.cwd(), "public/fonts", file));
const regular = face("Geist-Regular.ttf"),
  semibold = face("Geist-SemiBold.ttf");
const fonts = Promise.all([regular, semibold, face("GeistMono-Medium.ttf")])
  .then(([regular, bold, mono]) => [
    {
      name: "Geist",
      data: regular,
      weight: 400 as const,
      style: "normal" as const,
    },
    {
      name: "Geist",
      data: bold,
      weight: 600 as const,
      style: "normal" as const,
    },
    {
      name: "Geist Mono",
      data: mono,
      weight: 500 as const,
      style: "normal" as const,
    },
  ])
  .catch((error: unknown) => {
    // A card in the renderer's own face beats no card at all.
    console.error("PnL card fonts unavailable", error);
    return undefined;
  });
/**
 * Whether the face a token symbol is drawn in (Geist SemiBold) has a glyph
 * for a code point; printable ASCII alone when the faces could not be read,
 * since the renderer's own fallback face draws that much.
 */
const symbolDrawable = semibold
  .then((data) => {
    const points = fontCodePoints(data);
    return (codePoint: number) => points.has(codePoint);
  })
  .catch(() => (codePoint: number) => codePoint >= 0x20 && codePoint < 0x7f);

/** Geist Regular's advance widths, or null when the face could not be read. */
const regularAdvances = regular.then(fontAdvances).catch(() => null);

const alpha = (hex: string, a: number) =>
  `rgba(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)}, ${a})`;
const tone = (t: CardStat["tone"]) =>
  t === "up"
    ? visualTheme.up
    : t === "down"
      ? visualTheme.down
      : visualTheme.text;
const mono = "Geist Mono";
/**
 * A token symbol's line: it takes the width its row has left and ends in an
 * ellipsis there, since the renderer never shrinks or wraps a word on its
 * own and a symbol's glyph count says nothing about its width ("WWWWWWWWW…"
 * is half as wide again as "BURRITOGA…").
 */
const symbolLine = {
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
} as const;

/**
 * The token's proxied image as a PNG data URI for the renderer, or null when
 * the pool has none or it is not ready within the card's own deadline; the
 * token's monogram then stands in, as it does on the site.
 */
async function tokenImage(poolId: string): Promise<string | null> {
  try {
    const response = await Promise.race([
      tokenImageResponse(
        new Request(`http://card.local/api/token-image/${poolId}/`),
        poolId,
      ),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500)),
    ]);
    if (!response || response.status !== 200) return null;
    const png = await sharp(Buffer.from(await response.arrayBuffer()))
      .png()
      .toBuffer();
    return `data:image/png;base64,${png.toString("base64")}`;
  } catch {
    return null;
  }
}

/**
 * A run of text drawn one glyph to a box. The renderer sizes a word by its
 * glyphs' advances but draws it kerned, so a word with tight pairs ends
 * short of its box and the next word drifts away from it: a dollar figure's
 * "7," and ",1" left "+$169,107.07  realized" five pixels wider apart than
 * "+62.48 ETH realized". One glyph to a box, each is drawn where it is
 * measured. `style` is the run's text style; the line breaks nowhere.
 */
function Glyphs({ text, style }: { text: string; style: CSSProperties }) {
  return (
    <span style={{ ...style, display: "flex", whiteSpace: "pre" }}>
      {[...text].map((glyph, i) => (
        <span key={i}>{glyph}</span>
      ))}
    </span>
  );
}

/**
 * A money figure drawn as the site draws it: the plain string, or the
 * subscript-zero form with the zero count set small on the baseline's lower
 * edge, since the renderer has no `<sub>` and no font feature for one. A USD
 * figure carries its "$" in the figure itself, so it has no unit to set apart.
 */
function CardFigure({
  money,
  size,
  color,
  letterSpacing = 0,
  unit: ethUnit,
}: {
  money: CardMoney;
  size: number;
  color: string;
  letterSpacing?: number;
  /** Sets the ETH unit apart, smaller and quieter, beside an amount a label names. */
  unit?: { size: number; color: string };
}) {
  const unit = money.currency === "ETH" ? ethUnit : undefined;
  const text = {
    fontSize: size,
    fontWeight: 600,
    lineHeight: 1,
    letterSpacing,
    color,
    // One line always: a figure that ever ran past its size estimate would
    // otherwise wrap its unit onto a second line and push the card apart.
    whiteSpace: "nowrap",
  } as const;
  const usd = money.currency === "USD",
    suffix = unit || usd ? "" : " ETH",
    // A dollar figure's grouping commas kern tight, so it is drawn a glyph
    // to a box (`Glyphs`); an ETH figure keeps the run it always had.
    run = (content: string, style: CSSProperties) =>
      usd ? (
        <Glyphs text={content} style={style} />
      ) : (
        <span style={style}>{content}</span>
      );
  const figure =
    money.figure.form === "plain" ? (
      run(`${money.sign}${money.figure.text}${suffix}`, text)
    ) : (
      <span style={{ display: "flex", alignItems: "flex-end" }}>
        {run(`${money.sign}${money.figure.sign}${usd ? "$" : ""}0.0`, text)}
        <span style={{ ...text, fontSize: Math.round(size * 0.55) }}>
          {String(money.figure.zeros)}
        </span>
        {run(`${money.figure.digits}${suffix}`, text)}
      </span>
    );
  if (!unit) return figure;
  return (
    <span style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
      {figure}
      <span
        style={{
          fontSize: unit.size,
          lineHeight: 1,
          color: unit.color,
          whiteSpace: "nowrap",
        }}
      >
        ETH
      </span>
    </span>
  );
}

function Mark({ size, color }: { size: number; color: string }) {
  return (
    <svg
      width={size}
      height={Math.round((size * 26) / 22)}
      viewBox="0 0 22 26"
      fill="none"
    >
      <ellipse
        cx="11"
        cy="6"
        rx="9"
        ry="4.4"
        stroke={color}
        strokeWidth="1.8"
      />
      <ellipse
        cx="11"
        cy="12.4"
        rx="9"
        ry="4.4"
        stroke={color}
        strokeWidth="1.8"
        opacity=".62"
      />
      <ellipse
        cx="11"
        cy="18.8"
        rx="9"
        ry="4.4"
        stroke={color}
        strokeWidth="1.8"
        opacity=".3"
      />
    </svg>
  );
}

/**
 * The site's identity tile for a wallet or a token: two glyphs from the
 * address on the hue the address itself draws (`Avatar` in ui.tsx and the
 * shared `identityTint`), so the card shows the tile the wallet page and its
 * rows show, on both designs. Anonymous mode keeps the neutral person tile.
 */
function Monogram({
  address,
  size,
  radius,
  anonymous = false,
  label,
}: {
  address: string;
  size: number;
  radius: number;
  anonymous?: boolean;
  /** The tile's letters where they are not the address's own: a token's
   * symbol initials, or null for the site's letterless wallet tile. */
  label?: string | null;
}) {
  if (anonymous) {
    const icon = Math.round(size * 0.46);
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: size,
          height: size,
          borderRadius: radius,
          background: visualTheme.surface4,
          border: `1px solid ${visualTheme.lineRaised}`,
          flexShrink: 0,
        }}
      >
        <svg width={icon} height={icon} viewBox="0 0 24 24" fill="none">
          <circle
            cx="12"
            cy="8"
            r="4.2"
            stroke={visualTheme.muted}
            strokeWidth="1.8"
          />
          <path
            d="M4.5 20.5c1.2-4 4.1-6 7.5-6s6.3 2 7.5 6"
            stroke={visualTheme.muted}
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        </svg>
      </div>
    );
  }
  const tint = identityTint(address);
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        borderRadius: radius,
        background: tint.background,
        color: tint.foreground,
        fontSize: Math.round(size * 0.36),
        fontWeight: 600,
        lineHeight: 1,
        flexShrink: 0,
      }}
    >
      {label === undefined ? cardInitials(address) : label}
    </div>
  );
}

const rankFormat = new Intl.NumberFormat("en-US");

/**
 * The captain's export layout: wordmark, window chip, monogram + name + rank,
 * the realized PnL headline in ETH, the fixed ROI / Record / Best trade trio
 * and the profile URL - exactly those eight elements, nothing else.
 */
function ExportCard({
  address,
  anonymous,
  preset,
  window,
  rank,
  hero,
  heroColor,
  trio,
}: {
  address: string;
  anonymous: boolean;
  preset: string;
  window: LiveWindow;
  rank: number | null;
  hero: CardMoney;
  heroColor: string;
  trio: CardExportTrio;
}) {
  const best = trio.bestTrade;
  const stats: { label: string; value: string | null; tile?: string }[] = [
    { label: "ROI", value: trio.roi },
    { label: "Record", value: trio.record },
    best && best.symbol === null
      ? { label: "Best trade", value: null, tile: best.token }
      : { label: "Best trade", value: best?.symbol ?? null },
  ];
  const heroSize = cardExportHeroSize(cardMoneyText(hero));
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        width: "100%",
        height: "100%",
        padding: "64px 72px",
        color: visualTheme.text,
        fontFamily: "Geist",
        backgroundColor: visualTheme.panelInset,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <Mark size={34} color={preset} />
          <div
            style={{
              display: "flex",
              fontSize: 53,
              fontWeight: 600,
              lineHeight: 1,
              letterSpacing: -1.6,
            }}
          >
            pools
            <span style={{ color: visualTheme.muted, fontWeight: 400 }}>
              info
            </span>
            <span style={{ color: preset }}>.</span>
          </div>
        </div>
        <span
          style={{
            display: "flex",
            fontFamily: mono,
            fontSize: 33,
            fontWeight: 400,
            lineHeight: 1,
            letterSpacing: 3,
            color: visualTheme.muted,
            border: `1px solid ${visualTheme.lineActive}`,
            borderRadius: 10,
            padding: "10px 18px",
          }}
        >
          {cardWindowLabel(window)} REALIZED
        </span>
      </div>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          flex: 1,
          justifyContent: "space-between",
          marginTop: 40,
        }}
      >
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
            <Monogram
              address={address}
              size={56}
              radius={16}
              anonymous={anonymous}
            />
            <span style={{ fontSize: 57, fontWeight: 500, lineHeight: 1 }}>
              {anonymous ? "Anonymous" : shortAddress(address)}
            </span>
            {!anonymous && rank !== null && (
              <span
                style={{
                  display: "flex",
                  fontSize: 37,
                  fontWeight: 600,
                  lineHeight: 1,
                  color: preset,
                  background: "rgba(255, 255, 255, 0.07)",
                  borderRadius: 10,
                  padding: "8px 16px",
                }}
              >
                {`RANK ${rankFormat.format(rank)}`}
              </span>
            )}
          </div>
          <div style={{ display: "flex", marginTop: 12 }}>
            <CardFigure
              money={hero}
              size={heroSize}
              color={heroColor}
              letterSpacing={-heroSize * 0.045}
            />
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "flex", gap: 56 }}>
            {stats.map((s) => (
              <div
                key={s.label}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                  // ROI and Record keep their figures whole; Best trade has
                  // the rest of the row, so a long symbol meets its ellipsis
                  // there rather than the card's edge.
                  ...(s.label === "Best trade"
                    ? { flex: 1, minWidth: 0 }
                    : { flexShrink: 0 }),
                }}
              >
                <span
                  style={{
                    fontSize: 33,
                    fontWeight: 400,
                    lineHeight: 1,
                    color: visualTheme.muted,
                  }}
                >
                  {s.label}
                </span>
                {s.tile ? (
                  <Monogram address={s.tile} size={57} radius={16} />
                ) : (
                  <span
                    style={{
                      fontSize: 57,
                      fontWeight: 600,
                      lineHeight: 1,
                      ...symbolLine,
                    }}
                  >
                    {s.value ?? ""}
                  </span>
                )}
              </div>
            ))}
          </div>
          <span
            style={{
              display: "flex",
              alignSelf: "flex-end",
              fontFamily: mono,
              fontSize: 24,
              fontWeight: 400,
              lineHeight: 1,
              color: visualTheme.muted,
            }}
          >
            {anonymous
              ? "poolsinfo.com"
              : `poolsinfo.com/wallet/${shortAddress(address)}`}
          </span>
        </div>
      </div>
    </div>
  );
}

/** The left-hand column the figures take, the right-hand one, and the OPEN
 * card's chart inside it: the end dot and its halo sit within its edge. */
const positionLeftColumn = 580,
  positionColumn = 470,
  positionChart = { width: 458, height: 232 };

/**
 * The position card: one wallet's history in one token, from the ledger's
 * lifetime state, never a window. OPEN draws the pool's price with the held
 * units' entry and mark levels where they are served; CLOSED, or OPEN on a
 * pool with no price history served, draws ETH in against ETH out. A figure
 * the read does not serve leaves its cell out.
 */
function PositionCard({
  address,
  anonymous,
  preset,
  position,
  figures: f,
  image,
  drawable,
  usdPerEth,
  lineAdvances,
}: {
  address: string;
  anonymous: boolean;
  preset: string;
  position: CardPosition;
  figures: PositionCardFigures;
  image: string | null;
  drawable: (codePoint: number) => boolean;
  /** Draws every amount and price in USD at this served rate; null is ETH. */
  usdPerEth: number | null;
  lineAdvances: Map<number, number> | null;
}) {
  const money = (eth: CardEth) => cardMoney(eth, usdPerEth),
    row = position.source.position,
    color = tone(f.hero.tone),
    symbol = cardSymbol(row.symbol, drawable),
    name = cardSymbol(position.pool.name, drawable),
    label = {
      fontFamily: mono,
      fontSize: 15,
      letterSpacing: 2,
      color: visualTheme.muted,
    } as const,
    chart = f.open
      ? positionCardChart(
          position.candles,
          position.source.avgEntryPriceWei,
          position.source.mark?.priceWei ?? null,
          positionChart.width,
          positionChart.height,
        )
      : null,
    path =
      chart?.points
        .map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`)
        .join(" ") ?? "",
    end = chart?.points[chart.points.length - 1],
    endY = chart?.markY ?? end?.[1],
    unrealized =
      f.hero.label !== "Realized ROI"
        ? null
        : f.unrealized
          ? `${cardMoneyText(money(f.unrealized))} unrealized${f.unrealizedRoi ? ` (${f.unrealizedRoi})` : ""}`
          : !f.notional && f.unrealizedRoi
            ? `${f.unrealizedRoi} unrealized`
            : null,
    /* Units held and what they are worth, on the left column's one line:
       sized to fit it, and past the smallest size without the symbol, which
       the token line above already names. */
    held = (named: boolean) =>
      [
        f.notional
          ? f.holding === null
            ? null
            : `Still holding ${f.holding}${named && symbol ? ` ${symbol}` : ""}`
          : `Still holding${named && symbol ? ` ${symbol}` : ""}`,
        f.hero.label === "Unrealized PnL"
          ? f.unrealizedRoi && `${f.unrealizedRoi} unrealized`
          : unrealized,
      ]
        .filter(Boolean)
        .join(" · "),
    // The left column's width: a line the renderer measures within it fits.
    holdingWidth = positionLeftColumn,
    holdingMin = 15,
    holding =
      cardLineSize(lineAdvances, held(true), holdingWidth, 20) >= holdingMin
        ? held(true)
        : held(false),
    holdingSize = Math.max(
      holdingMin,
      cardLineSize(lineAdvances, holding, holdingWidth, 20),
    ),
    tradeCount = new Intl.NumberFormat("en-US"),
    strip: (
      { label: string; eth: CardEth } | { label: string; value: string }
    )[] = [
      ...(f.notional
        ? [
            { label: "ETH IN", eth: f.invested },
            { label: "ETH OUT", eth: f.proceeds },
            {
              label: "TRADES",
              value: `${countLabel(f.buys, "buy")} · ${countLabel(f.sells, "sell")}`,
            },
          ]
        : [
            // Notional hidden: the counts alone, each in its own cell.
            { label: "BUYS", value: tradeCount.format(f.buys) },
            { label: "SELLS", value: tradeCount.format(f.sells) },
          ]),
      ...(f.held === null ? [] : [{ label: "HELD", value: f.held }]),
    ],
    // A hold is a few glyphs, so beside it the trade counts take its room.
    stripShare = (label: string) =>
      strip.length < 4
        ? 1
        : label === "HELD"
          ? 0.6
          : label === "TRADES"
            ? 1.4
            : 1,
    // Each figure takes the strip's size or less: the renderer never shrinks
    // a long count ("1,234 buys · 5,678 sells") to fit its cell on its own.
    stripSize = (label: string, text: string) =>
      cardExportHeroSize(
        text,
        (1070 * stripShare(label)) / strip.length - 64,
        strip.length > 3 ? 26 : 30,
      );
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        width: "100%",
        height: "100%",
        padding: "44px 64px 40px",
        color: visualTheme.text,
        fontFamily: "Geist",
        backgroundColor: visualTheme.panelInset,
        backgroundImage: `radial-gradient(circle at 0% 0%, ${alpha(preset, 0.3)} 0%, ${alpha(preset, 0)} 52%), radial-gradient(circle at 100% 100%, ${alpha(preset, 0.12)} 0%, ${alpha(preset, 0)} 42%)`,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          height: 36,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <Mark size={30} color={preset} />
          <div
            style={{
              display: "flex",
              fontSize: 30,
              fontWeight: 600,
              letterSpacing: -1,
            }}
          >
            pools
            <span style={{ color: visualTheme.muted, fontWeight: 400 }}>
              info
            </span>
            <span style={{ color: preset }}>.</span>
          </div>
        </div>
        <span
          style={{
            ...label,
            fontSize: 18,
            color: f.open ? preset : visualTheme.text3,
            border: `1px solid ${f.open ? alpha(preset, 0.5) : visualTheme.lineRaised}`,
            background: f.open ? alpha(preset, 0.07) : "transparent",
            borderRadius: 9,
            padding: "6px 14px",
          }}
        >
          {`POSITION · ${f.open ? "OPEN" : "CLOSED"}`}
        </span>
      </div>
      <div
        style={{
          display: "flex",
          flex: 1,
          justifyContent: "space-between",
          marginTop: 24,
          marginBottom: 26,
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
            width: positionLeftColumn,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 14,
              height: 52,
            }}
          >
            {image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={image}
                alt=""
                width={52}
                height={52}
                style={{ borderRadius: 26, objectFit: "cover", flexShrink: 0 }}
              />
            ) : (
              <Monogram
                address={row.token}
                size={52}
                radius={26}
                label={tokenInitials(symbol)}
              />
            )}
            {symbol !== null && (
              <span
                style={{
                  ...symbolLine,
                  maxWidth: 300,
                  fontSize: 34,
                  fontWeight: 600,
                  letterSpacing: -0.5,
                }}
              >
                {symbol}
              </span>
            )}
            {name !== null && name !== symbol && (
              <span
                style={{
                  ...symbolLine,
                  maxWidth: 190,
                  fontSize: 20,
                  color: visualTheme.muted,
                }}
              >
                {name}
              </span>
            )}
            {position.pool.launchType && (
              <span
                style={{
                  ...label,
                  fontSize: 13,
                  letterSpacing: 2,
                  color: visualTheme.text2,
                  border: `1px solid ${visualTheme.lineRaised}`,
                  borderRadius: 6,
                  padding: "5px 10px",
                  flexShrink: 0,
                }}
              >
                {position.pool.launchType.toUpperCase()}
              </span>
            )}
          </div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <span style={label}>{f.hero.label.toUpperCase()}</span>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                height: 112,
                marginTop: 10,
              }}
            >
              {f.hero.eth ? (
                <CardFigure
                  money={money(f.hero.eth)}
                  size={cardExportHeroSize(
                    cardMoneyText(money(f.hero.eth)),
                    570,
                    84,
                  )}
                  color={color}
                  letterSpacing={-3}
                />
              ) : (
                f.hero.value !== null && (
                  <span
                    style={{
                      fontSize: f.hero.value.length > 9 ? 84 : 104,
                      fontWeight: 600,
                      lineHeight: 1,
                      letterSpacing: -4,
                      color,
                    }}
                  >
                    {f.hero.value}
                  </span>
                )
              )}
            </div>
            {f.realized && (
              <div
                style={{
                  display: "flex",
                  alignItems: "flex-end",
                  gap: 8,
                  height: 38,
                }}
              >
                <CardFigure money={money(f.realized)} size={30} color={color} />
                <span
                  style={{
                    fontSize: 30,
                    fontWeight: 600,
                    lineHeight: 1,
                    color,
                  }}
                >
                  realized
                </span>
              </div>
            )}
            {f.open &&
              holding &&
              (usdPerEth === null ? (
                <span
                  style={{
                    ...symbolLine,
                    fontSize: holdingSize,
                    lineHeight: 1,
                    color: visualTheme.text3,
                    marginTop: 14,
                  }}
                >
                  {holding}
                </span>
              ) : (
                <Glyphs
                  text={holding}
                  style={{
                    fontSize: holdingSize,
                    lineHeight: 1,
                    color: visualTheme.text3,
                    marginTop: 14,
                    overflow: "hidden",
                  }}
                />
              ))}
          </div>
        </div>
        {/* The price chart where the pool serves one; else, and on a closed
            position, ETH in against ETH out. */}
        {chart && end && endY !== undefined ? (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              width: positionColumn,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                height: 28,
              }}
            >
              <span style={label}>POOL PRICE</span>
              {f.mark && (
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <span style={label}>MARK</span>
                  <CardFigure
                    money={money(f.mark)}
                    size={19}
                    color={visualTheme.text}
                    unit={{ size: 15, color: visualTheme.text3 }}
                  />
                </div>
              )}
            </div>
            <div
              style={{
                display: "flex",
                position: "relative",
                marginTop: 18,
                width: positionColumn,
                height: positionChart.height,
              }}
            >
              <svg
                width={positionChart.width + 24}
                height={positionChart.height + 24}
                viewBox={`-12 -12 ${positionChart.width + 24} ${positionChart.height + 24}`}
                style={{ position: "absolute", left: -12, top: -12 }}
              >
                <defs>
                  <linearGradient
                    id="position-fill"
                    x1="0"
                    y1="0"
                    x2="0"
                    y2="1"
                  >
                    <stop offset="0" stopColor={color} stopOpacity="0.22" />
                    <stop offset="1" stopColor={color} stopOpacity="0" />
                  </linearGradient>
                </defs>
                {[0.25, 0.5, 0.75].map((y) => (
                  <line
                    key={y}
                    x1="0"
                    x2={positionChart.width}
                    y1={positionChart.height * y}
                    y2={positionChart.height * y}
                    stroke={visualTheme.lineRaised}
                    strokeWidth="1"
                    strokeDasharray="2 6"
                  />
                ))}
                {[
                  <path
                    key="area"
                    d={`${path} L${end[0].toFixed(1)} ${positionChart.height} L0 ${positionChart.height} Z`}
                    fill="url(#position-fill)"
                  />,
                  chart.entryY !== null && (
                    <line
                      key="entry"
                      x1="0"
                      x2={positionChart.width}
                      y1={chart.entryY}
                      y2={chart.entryY}
                      stroke={visualTheme.muted}
                      strokeWidth="1.5"
                      strokeDasharray="6 6"
                    />
                  ),
                  <path
                    key="line"
                    d={path}
                    fill="none"
                    stroke={color}
                    strokeWidth="2.5"
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />,
                  <circle
                    key="halo"
                    cx={end[0]}
                    cy={endY}
                    r="11"
                    fill={color}
                    fillOpacity="0.25"
                  />,
                  <circle
                    key="end"
                    cx={end[0]}
                    cy={endY}
                    r="6"
                    fill={color}
                    stroke={visualTheme.panelInset}
                    strokeWidth="2.5"
                  />,
                ]}
              </svg>
              {f.entry && chart.entryY !== null && (
                <div
                  style={{
                    display: "flex",
                    position: "absolute",
                    right: 0,
                    top: Math.max(
                      0,
                      Math.min(chart.entryY, positionChart.height) - 36,
                    ),
                    alignItems: "center",
                    gap: 12,
                    padding: "4px 8px",
                    background: alpha(visualTheme.panelInset, 0.85),
                  }}
                >
                  <span style={label}>ENTRY</span>
                  <CardFigure
                    money={money(f.entry)}
                    size={19}
                    color={visualTheme.text}
                    unit={{ size: 15, color: visualTheme.text3 }}
                  />
                </div>
              )}
            </div>
          </div>
        ) : (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              width: positionColumn,
              paddingTop: 48,
            }}
          >
            {[
              {
                label: "ETH IN",
                eth: f.invested,
                share: f.bars.invested,
                fill: visualTheme.lineBright,
              },
              {
                label: "ETH OUT",
                eth: f.proceeds,
                share: f.bars.proceeds,
                fill: color,
              },
            ].map((bar) => (
              <div
                key={bar.label}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 12,
                  marginBottom: 39,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "flex-end",
                    justifyContent: "space-between",
                  }}
                >
                  <span style={label}>{bar.label}</span>
                  {/* Notional hidden, the bars keep their lengths and the
                      multiple beside them, but not the amounts. */}
                  {f.notional && (
                    <CardFigure
                      money={money(bar.eth)}
                      size={26}
                      color={visualTheme.text}
                      unit={{ size: 18, color: visualTheme.text3 }}
                    />
                  )}
                </div>
                <div
                  style={{
                    display: "flex",
                    height: 20,
                    borderRadius: 10,
                    background: alpha(visualTheme.surface4, 0.85),
                    border: `1px solid ${visualTheme.lineRaised}`,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      width: `${bar.share}%`,
                      minWidth: bar.share > 0 ? 18 : 0,
                      height: "100%",
                      borderRadius: 10,
                      background: bar.fill,
                    }}
                  />
                </div>
              </div>
            ))}
            {f.multiple && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "flex-end",
                  gap: 14,
                }}
              >
                <span style={label}>OUT / IN</span>
                <span
                  style={{
                    fontSize: 36,
                    fontWeight: 600,
                    lineHeight: 1,
                    color,
                  }}
                >
                  {f.multiple}
                </span>
              </div>
            )}
          </div>
        )}
      </div>
      <div
        style={{
          display: "flex",
          height: 92,
          flexShrink: 0,
          padding: "18px 0",
          background: alpha(visualTheme.surface4, 0.85),
          border: `1px solid ${visualTheme.lineRaised}`,
          borderRadius: 18,
        }}
      >
        {strip.map((cell, i) => (
          <div
            key={cell.label}
            style={{
              display: "flex",
              flex: stripShare(cell.label),
              flexDirection: "column",
              justifyContent: "space-between",
              padding: "0 32px",
              borderLeft: `1px solid ${i ? visualTheme.lineRaised : "transparent"}`,
            }}
          >
            <span style={label}>{cell.label}</span>
            {"eth" in cell ? (
              <CardFigure
                money={money(cell.eth)}
                size={stripSize(cell.label, cardMoneyText(money(cell.eth)))}
                color={visualTheme.text}
              />
            ) : (
              <span
                style={{
                  fontSize: stripSize(cell.label, cell.value),
                  fontWeight: 600,
                  lineHeight: 1,
                  whiteSpace: "nowrap",
                }}
              >
                {cell.value}
              </span>
            )}
          </div>
        ))}
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginTop: 22,
          height: 26,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Monogram
            address={address}
            size={26}
            radius={7}
            anonymous={anonymous}
            label={null}
          />
          <span style={{ fontSize: 20, color: visualTheme.text3 }}>
            {anonymous ? "Anonymous" : shortAddress(address)}
          </span>
          {!anonymous && position.rank !== null && (
            <span
              style={{
                ...label,
                fontSize: 12,
                color: preset,
                background: alpha(preset, 0.1),
                borderRadius: 6,
                padding: "6px 9px",
              }}
            >
              {`RANK ${rankFormat.format(position.rank)}`}
            </span>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <Mark size={17} color={preset} />
          <span style={{ fontSize: 19, color: visualTheme.text3 }}>
            {anonymous
              ? "poolsinfo.com"
              : `poolsinfo.com/wallet/${shortAddress(address)}`}
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * The export layout for a position: the portfolio export's wordmark, chip,
 * identity line, amount headline, fixed trio and profile URL, with the token
 * where the wallet was and the wallet beside the URL. The headline is the
 * lifetime realized amount, or before a first sale the held units'
 * unrealized amount in the neutral colour; the trio is the realized ROI, the
 * trade counts, and the unrealized ROI on an open position or ETH out over
 * ETH in on a closed one, each slot left empty where it is not served.
 */
function PositionExportCard({
  address,
  anonymous,
  preset,
  position,
  figures: f,
  image,
  drawable,
  usdPerEth,
}: {
  address: string;
  anonymous: boolean;
  preset: string;
  position: CardPosition;
  figures: PositionCardFigures;
  image: string | null;
  drawable: (codePoint: number) => boolean;
  usdPerEth: number | null;
}) {
  const row = position.source.position,
    symbol = cardSymbol(row.symbol, drawable),
    realized = f.hero.label === "Realized ROI",
    hero = realized ? f.realized : f.hero.eth,
    heroMoney = hero && cardMoney(hero, usdPerEth),
    heroSize = heroMoney ? cardExportHeroSize(cardMoneyText(heroMoney)) : 0,
    count = new Intl.NumberFormat("en-US"),
    stats: { label: string; value: string | null }[] = [
      { label: "ROI", value: realized ? f.hero.value : null },
      {
        label: "Buys · Sells",
        value: `${count.format(f.buys)} · ${count.format(f.sells)}`,
      },
      f.open
        ? { label: "Unrealized", value: f.unrealizedRoi }
        : { label: "Out / In", value: f.multiple },
    ];
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        width: "100%",
        height: "100%",
        padding: "64px 72px",
        color: visualTheme.text,
        fontFamily: "Geist",
        backgroundColor: visualTheme.panelInset,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <Mark size={34} color={preset} />
          <div
            style={{
              display: "flex",
              fontSize: 53,
              fontWeight: 600,
              lineHeight: 1,
              letterSpacing: -1.6,
            }}
          >
            pools
            <span style={{ color: visualTheme.muted, fontWeight: 400 }}>
              info
            </span>
            <span style={{ color: preset }}>.</span>
          </div>
        </div>
        <span
          style={{
            display: "flex",
            fontFamily: mono,
            fontSize: 33,
            fontWeight: 400,
            lineHeight: 1,
            letterSpacing: 3,
            color: f.open ? preset : visualTheme.muted,
            border: `1px solid ${f.open ? alpha(preset, 0.5) : visualTheme.lineActive}`,
            borderRadius: 10,
            padding: "10px 18px",
          }}
        >
          {`${f.open ? "OPEN" : "CLOSED"} ${realized ? "REALIZED" : "UNREALIZED"}`}
        </span>
      </div>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          flex: 1,
          justifyContent: "space-between",
          marginTop: 40,
        }}
      >
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
            {image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={image}
                alt=""
                width={56}
                height={56}
                style={{ borderRadius: 28, objectFit: "cover", flexShrink: 0 }}
              />
            ) : (
              <Monogram
                address={row.token}
                size={56}
                radius={28}
                label={tokenInitials(symbol)}
              />
            )}
            {symbol !== null && (
              <span
                style={{
                  fontSize: 57,
                  fontWeight: 500,
                  lineHeight: 1,
                  ...symbolLine,
                }}
              >
                {symbol}
              </span>
            )}
            {position.pool.launchType && (
              <span
                style={{
                  display: "flex",
                  flexShrink: 0,
                  fontFamily: mono,
                  fontSize: 26,
                  lineHeight: 1,
                  letterSpacing: 3,
                  color: visualTheme.text2,
                  border: `1px solid ${visualTheme.lineRaised}`,
                  borderRadius: 10,
                  padding: "8px 14px",
                }}
              >
                {position.pool.launchType.toUpperCase()}
              </span>
            )}
          </div>
          <div style={{ display: "flex", height: 207, marginTop: 12 }}>
            {heroMoney && (
              <CardFigure
                money={heroMoney}
                size={heroSize}
                color={tone(realized ? f.hero.tone : "text")}
                letterSpacing={-heroSize * 0.045}
              />
            )}
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "flex", gap: 56 }}>
            {stats.map((s) => (
              <div
                key={s.label}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                  ...(s === stats[stats.length - 1]
                    ? { flex: 1, minWidth: 0 }
                    : { flexShrink: 0 }),
                }}
              >
                <span
                  style={{
                    fontSize: 33,
                    fontWeight: 400,
                    lineHeight: 1,
                    color: visualTheme.muted,
                  }}
                >
                  {s.label}
                </span>
                <span
                  style={{
                    fontSize: 57,
                    fontWeight: 600,
                    lineHeight: 1,
                    ...symbolLine,
                  }}
                >
                  {s.value ?? ""}
                </span>
              </div>
            ))}
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              height: 28,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <Monogram
                address={address}
                size={28}
                radius={8}
                anonymous={anonymous}
                label={null}
              />
              <span
                style={{
                  fontSize: 24,
                  lineHeight: 1,
                  color: visualTheme.muted,
                }}
              >
                {anonymous ? "Anonymous" : shortAddress(address)}
              </span>
              {!anonymous && position.rank !== null && (
                <span
                  style={{
                    display: "flex",
                    fontSize: 18,
                    fontWeight: 600,
                    lineHeight: 1,
                    color: preset,
                    background: "rgba(255, 255, 255, 0.07)",
                    borderRadius: 7,
                    padding: "5px 10px",
                  }}
                >
                  {`RANK ${rankFormat.format(position.rank)}`}
                </span>
              )}
            </div>
            <span
              style={{
                display: "flex",
                fontFamily: mono,
                fontSize: 24,
                fontWeight: 400,
                lineHeight: 1,
                color: visualTheme.muted,
              }}
            >
              {anonymous
                ? "poolsinfo.com"
                : `poolsinfo.com/wallet/${shortAddress(address)}`}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

/** A card at the 1200x630 every share target unfurls, as the renderer writes it. */
async function renderCard(card: ReactElement) {
  const image = new ImageResponse(card, {
    width: 1200,
    height: 630,
    fonts: await fonts,
  });
  return image.arrayBuffer();
}
const pngResponse = (png: ArrayBuffer | Uint8Array<ArrayBuffer>) =>
  new Response(png, {
    headers: { "Content-Type": "image/png", "Cache-Control": "no-store" },
  });

export async function GET(
  request: Request,
  { params }: { params: Promise<{ filename: string }> },
) {
  const { filename } = await params;
  if (!/^0x[0-9a-f]{40}\.png$/i.test(filename))
    return new Response("Invalid wallet address", { status: 404 });
  const address = filename.slice(0, -4).toLowerCase(),
    q = new URL(request.url).searchParams,
    options = parseCardOptions(q);
  try {
    const poolId = q.get("pool")?.toLowerCase(),
      launch = q.get("launch")?.toLowerCase();
    if (
      (poolId !== undefined && !/^0x[0-9a-f]{64}$/.test(poolId)) ||
      (launch !== undefined && !/^0x[0-9a-f]{64}$/.test(launch))
    )
      return new Response("Invalid pool scope", { status: 400 });
    const usdPerEth =
      options.unit === "USD" ? await cardUsdPerEth(options.usdPerEth) : null;
    if (poolId !== undefined) {
      // The export layout's headline is the realized amount, notional or not.
      const position = await readCardPosition(address, poolId, launch),
        figures =
          position &&
          positionCardFigures(
            position.source,
            options.design === "export" || options.notional,
          );
      if (!position || !figures)
        return new Response(
          "No supported position for this wallet in this pool",
          { status: 404, headers: { "Cache-Control": "no-store" } },
        );
      const card = {
        address,
        anonymous: options.anonymous,
        preset: cardPresets[options.preset].color,
        position,
        figures,
        image: await tokenImage(poolId),
        drawable: await symbolDrawable,
        usdPerEth,
      };
      const png = await renderCard(
        options.design === "export" ? (
          <PositionExportCard {...card} />
        ) : (
          <PositionCard {...card} lineAdvances={await regularAdvances} />
        ),
      );
      // The renderer writes RGBA and the card is opaque: as RGB at the
      // strongest compression the same pixels take a sixth less, which holds
      // a price chart inside the card's size budget.
      return pngResponse(
        new Uint8Array(
          await sharp(Buffer.from(png))
            .flatten({ background: visualTheme.panelInset })
            .png({ compressionLevel: 9 })
            .toBuffer(),
        ),
      );
    }
    const { result } = await readCardWallet(address, options.window);
    const w = result.wallet,
      exportHero = options.design === "export" ? cardExportHero(w) : null,
      hero = options.design === "export" ? exportHero : cardHero(w);
    if (!cardTradeCount(w) || !hero)
      return new Response("No saved PnL for this wallet", { status: 404 });
    const preset = cardPresets[options.preset].color,
      top = cardTopPosition(result.positions),
      image =
        top && options.design === "liquid"
          ? await tokenImage(top.poolId)
          : null,
      drawable = await symbolDrawable,
      symbol = top ? cardSymbol(top.symbol, drawable) : null,
      stats = cardStats(w, options.notional),
      trio = cardExportTrio(w, top, drawable),
      heroColor = tone(hero.tone),
      curveColor = tone(
        w.realizedWei === null
          ? hero.tone
          : BigInt(w.realizedWei) > 0n
            ? "up"
            : BigInt(w.realizedWei) < 0n
              ? "down"
              : "text",
      );
    const chart = { width: 470, height: 290 },
      curve = cardCurve(result.curve, chart.width, chart.height);
    const path = curve
      ? curve.points
          .map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`)
          .join(" ")
      : "";
    const start = curve?.points[0],
      end = curve?.points[curve.points.length - 1];
    const card = await renderCard(
      exportHero ? (
        <ExportCard
          address={address}
          anonymous={options.anonymous}
          preset={preset}
          window={options.window}
          rank={w.rank}
          hero={cardMoney(exportHero.eth, usdPerEth)}
          heroColor={heroColor}
          trio={trio}
        />
      ) : (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            width: "100%",
            height: "100%",
            padding: "44px 64px 40px",
            color: visualTheme.text,
            fontFamily: "Geist",
            backgroundColor: visualTheme.panelInset,
            // The preset tints the card's chrome (mark, wordmark dot, identicon,
            // window pill) and this ambient glow, drawn at the Liquid reference's
            // strength so the chosen colour reads at a glance; the headline and
            // the curve keep the up/down colour, never the preset.
            backgroundImage: `radial-gradient(circle at 0% 0%, ${alpha(preset, 0.3)} 0%, ${alpha(preset, 0)} 52%), radial-gradient(circle at 100% 100%, ${alpha(preset, 0.12)} 0%, ${alpha(preset, 0)} 42%)`,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <Mark size={30} color={preset} />
            <div
              style={{
                display: "flex",
                fontSize: 30,
                fontWeight: 600,
                letterSpacing: -1,
              }}
            >
              pools
              <span style={{ color: visualTheme.muted, fontWeight: 400 }}>
                info
              </span>
              <span style={{ color: preset }}>.</span>
            </div>
          </div>
          <div style={{ display: "flex", flex: 1, marginTop: 26, gap: 40 }}>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                justifyContent: "space-between",
                width: 562,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                <Monogram
                  address={address}
                  size={52}
                  radius={14}
                  anonymous={options.anonymous}
                />
                <div
                  style={{ display: "flex", flexDirection: "column", gap: 4 }}
                >
                  <span
                    style={{ fontSize: 30, fontWeight: 600, lineHeight: 1.1 }}
                  >
                    {options.anonymous ? "Anonymous" : shortAddress(address)}
                  </span>
                  {!options.anonymous && w.rank !== null && (
                    <span
                      style={{
                        fontSize: 18,
                        color: visualTheme.muted,
                        lineHeight: 1.1,
                      }}
                    >
                      {`Rank ${new Intl.NumberFormat("en-US").format(w.rank)}`}
                    </span>
                  )}
                </div>
              </div>
              {top && (
                <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                  {image ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={image}
                      width={40}
                      height={40}
                      alt=""
                      style={{
                        borderRadius: 20,
                        border: `1px solid ${visualTheme.lineRaised}`,
                        flexShrink: 0,
                      }}
                    />
                  ) : (
                    <Monogram address={top.token} size={40} radius={12} />
                  )}
                  {symbol !== null && (
                    <span
                      style={{
                        fontSize: 34,
                        fontWeight: 600,
                        lineHeight: 1,
                        ...symbolLine,
                      }}
                    >
                      {symbol}
                    </span>
                  )}
                  <span
                    style={{
                      display: "flex",
                      flexShrink: 0,
                      padding: "6px 12px",
                      border: `1px solid ${alpha(preset, 0.5)}`,
                      borderRadius: 9,
                      fontFamily: mono,
                      fontSize: 17,
                      fontWeight: 500,
                      letterSpacing: 2,
                      lineHeight: 1,
                      color: preset,
                    }}
                  >
                    {cardWindowLabel(options.window)}
                  </span>
                </div>
              )}
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 12,
                  marginTop: 8,
                }}
              >
                <span
                  style={{
                    fontSize: hero.value.length > 9 ? 84 : 104,
                    fontWeight: 600,
                    letterSpacing: -4,
                    lineHeight: 1,
                    color: heroColor,
                  }}
                >
                  {hero.value}
                </span>
                {options.notional && w.realizedWei !== null && (
                  <CardFigure
                    money={cardMoney(
                      cardEthFigure(w.realizedWei, true),
                      usdPerEth,
                    )}
                    size={30}
                    color={heroColor}
                  />
                )}
              </div>
            </div>
            <div
              style={{
                display: "flex",
                flex: 1,
                alignItems: "center",
                justifyContent: "flex-end",
              }}
            >
              <svg
                width={chart.width}
                height={chart.height + 24}
                viewBox={`-12 -12 ${chart.width + 24} ${chart.height + 24}`}
              >
                <defs>
                  <linearGradient id="fill" x1="0" y1="0" x2="0" y2="1">
                    <stop
                      offset="0"
                      stopColor={curveColor}
                      stopOpacity="0.28"
                    />
                    <stop offset="1" stopColor={curveColor} stopOpacity="0" />
                  </linearGradient>
                </defs>
                {[0.25, 0.5, 0.75].map((f) => (
                  <line
                    key={f}
                    x1="0"
                    x2={chart.width}
                    y1={chart.height * f}
                    y2={chart.height * f}
                    stroke={visualTheme.lineRaised}
                    strokeWidth="1"
                    strokeDasharray="2 6"
                  />
                ))}
                {curve && start && end
                  ? [
                      curve.zeroY !== null && (
                        <line
                          key="zero"
                          x1="0"
                          x2={chart.width}
                          y1={curve.zeroY}
                          y2={curve.zeroY}
                          stroke={visualTheme.lineBright}
                          strokeWidth="1"
                        />
                      ),
                      <path
                        key="area"
                        d={`${path} L${end[0].toFixed(1)} ${chart.height} L${start[0].toFixed(1)} ${chart.height} Z`}
                        fill="url(#fill)"
                      />,
                      <path
                        key="line"
                        d={path}
                        fill="none"
                        stroke={curveColor}
                        strokeWidth="3"
                        strokeLinejoin="round"
                        strokeLinecap="round"
                      />,
                      <circle
                        key="start"
                        cx={start[0]}
                        cy={start[1]}
                        r="7"
                        fill={visualTheme.panelInset}
                        stroke={visualTheme.text2}
                        strokeWidth="3"
                      />,
                      <circle
                        key="halo"
                        cx={end[0]}
                        cy={end[1]}
                        r="13"
                        fill={curveColor}
                        fillOpacity="0.25"
                      />,
                      <circle
                        key="end"
                        cx={end[0]}
                        cy={end[1]}
                        r="7"
                        fill={curveColor}
                        stroke={visualTheme.panelInset}
                        strokeWidth="3"
                      />,
                    ]
                  : [
                      <line
                        key="baseline"
                        x1="0"
                        x2={chart.width}
                        y1={chart.height / 2}
                        y2={chart.height / 2}
                        stroke={visualTheme.lineBright}
                        strokeWidth="3"
                        strokeLinecap="round"
                      />,
                    ]}
              </svg>
            </div>
          </div>
          <div
            style={{
              display: "flex",
              marginTop: 26,
              padding: "18px 0",
              borderRadius: 18,
              background: alpha(visualTheme.surface4, 0.85),
              border: `1px solid ${visualTheme.lineRaised}`,
            }}
          >
            {stats.map((s, i) => (
              <div
                key={s.label}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  flex: 1,
                  gap: 10,
                  padding: "0 32px",
                  borderLeft: i
                    ? `1px solid ${visualTheme.lineRaised}`
                    : "none",
                }}
              >
                <span
                  style={{
                    fontFamily: mono,
                    fontSize: 15,
                    fontWeight: 500,
                    letterSpacing: 2,
                    lineHeight: 1,
                    color: visualTheme.muted,
                    textTransform: "uppercase",
                  }}
                >
                  {s.label}
                </span>
                {s.eth ? (
                  <CardFigure
                    money={cardMoney(s.eth, usdPerEth)}
                    size={30}
                    color={tone(s.tone)}
                  />
                ) : (
                  <span
                    style={{
                      fontSize: 30,
                      fontWeight: 600,
                      lineHeight: 1,
                      color: tone(s.tone),
                    }}
                  >
                    {s.value}
                  </span>
                )}
              </div>
            ))}
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginTop: 20,
            }}
          >
            <span style={{ fontSize: 19, color: visualTheme.text3 }}>
              Explore pools on Robinhood Chain
            </span>
            <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
              <Mark size={17} color={preset} />
              <span style={{ fontSize: 19, color: visualTheme.text3 }}>
                poolsinfo.com
              </span>
            </div>
          </div>
        </div>
      ),
    );
    return pngResponse(card);
  } catch {
    return new Response("PnL card unavailable. Try again later.", {
      status: 503,
      headers: { "Cache-Control": "no-store", "Retry-After": "300" },
    });
  }
}
