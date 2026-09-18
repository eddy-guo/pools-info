import { ImageResponse } from "next/og";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import {
  cardCurve,
  cardEth,
  cardExportHero,
  cardExportHeroSize,
  cardExportTrio,
  cardHero,
  cardStats,
  cardTopPosition,
  identiconCells,
  readCardWallet,
  type CardExportTrio,
  type CardStat,
} from "@/lib/product-card";
import {
  cardPresets,
  cardWindowLabel,
  parseCardOptions,
} from "@/lib/card-options";
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
const fonts = Promise.all([
  face("Geist-Regular.ttf"),
  face("Geist-SemiBold.ttf"),
  face("GeistMono-Medium.ttf"),
])
  .then(([regular, semibold, mono]) => [
    {
      name: "Geist",
      data: regular,
      weight: 400 as const,
      style: "normal" as const,
    },
    {
      name: "Geist",
      data: semibold,
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
 * The token's proxied image as a PNG data URI for the renderer, or null when
 * the pool has none or it is not ready within the card's own deadline; the
 * identicon then stands in, as it does on the site.
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

function Identicon({
  address,
  size,
  color,
  radius,
}: {
  address: string;
  size: number;
  color: string;
  radius: number;
}) {
  const pad = Math.round(size * 0.22);
  return (
    <div
      style={{
        display: "flex",
        width: size,
        height: size,
        padding: pad,
        borderRadius: radius,
        background: alpha(color, 0.1),
        border: `1px solid ${alpha(color, 0.22)}`,
        flexShrink: 0,
      }}
    >
      <svg
        width={size - pad * 2 - 2}
        height={size - pad * 2 - 2}
        viewBox="0 0 5 5"
      >
        {identiconCells(address).map((c) => (
          <rect
            key={`${c.x}${c.y}`}
            x={c.x}
            y={c.y}
            width="1"
            height="1"
            fill={color}
          />
        ))}
      </svg>
    </div>
  );
}

/**
 * The export design's identity tile: a plain per-identity tinted box with no
 * letters and no grid, unlike the Liquid design's dotted {@link Identicon}.
 */
function Monogram({
  address,
  size,
  anonymous,
}: {
  address: string;
  size: number;
  anonymous: boolean;
}) {
  if (anonymous)
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: size,
          height: size,
          borderRadius: 16,
          background: visualTheme.surface4,
          border: `1px solid ${visualTheme.lineRaised}`,
          flexShrink: 0,
        }}
      >
        <svg
          width={Math.round(size * 0.46)}
          height={Math.round(size * 0.46)}
          viewBox="0 0 24 24"
          fill="none"
        >
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
  const tint = identityTint(address);
  return (
    <div
      style={{
        display: "flex",
        width: size,
        height: size,
        borderRadius: 16,
        background: tint.background,
        border: `2px solid ${tint.foreground}`,
        flexShrink: 0,
      }}
    />
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
  heroValue,
  heroColor,
  trio,
}: {
  address: string;
  anonymous: boolean;
  preset: string;
  window: LiveWindow;
  rank: number | null;
  heroValue: string;
  heroColor: string;
  trio: CardExportTrio;
}) {
  const stats: { label: string; value: string | null }[] = [
    { label: "ROI", value: trio.roi },
    { label: "Record", value: trio.record },
    { label: "Best trade", value: trio.bestTrade },
  ];
  const heroSize = cardExportHeroSize(heroValue);
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
            <Monogram address={address} size={56} anonymous={anonymous} />
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
          <span
            style={{
              marginTop: 12,
              fontSize: heroSize,
              fontWeight: 600,
              letterSpacing: -heroSize * 0.045,
              lineHeight: 1,
              color: heroColor,
            }}
          >
            {heroValue}
          </span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "flex", gap: 56 }}>
            {stats.map((s) => (
              <div
                key={s.label}
                style={{ display: "flex", flexDirection: "column", gap: 8 }}
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
                <span style={{ fontSize: 57, fontWeight: 600, lineHeight: 1 }}>
                  {s.value ?? ""}
                </span>
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
      (poolId && !/^0x[0-9a-f]{64}$/.test(poolId)) ||
      (launch && !/^0x[0-9a-f]{64}$/.test(launch))
    )
      return new Response("Invalid pool scope", { status: 400 });
    const { result } = await readCardWallet(
      address,
      options.window,
      poolId,
      launch,
    );
    const w = result.wallet,
      hero = options.design === "export" ? cardExportHero(w) : cardHero(w);
    if (!w.tradeCount || !hero)
      return new Response("No saved PnL for this wallet", { status: 404 });
    const preset = cardPresets[options.preset].color,
      top = cardTopPosition(result.positions),
      image =
        top && options.design === "liquid"
          ? await tokenImage(top.poolId)
          : null,
      stats = cardStats(w, options.notional),
      trio = cardExportTrio(w, top?.symbol ?? null),
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
    const card = new ImageResponse(
      options.design === "export" ? (
        <ExportCard
          address={address}
          anonymous={options.anonymous}
          preset={preset}
          window={options.window}
          rank={w.rank}
          heroValue={hero.value}
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
            backgroundImage: `radial-gradient(circle at 0% 0%, ${alpha(preset, 0.16)} 0%, ${alpha(preset, 0)} 42%), radial-gradient(circle at 100% 100%, ${alpha(preset, 0.07)} 0%, ${alpha(preset, 0)} 38%)`,
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
                {options.anonymous ? (
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: 52,
                      height: 52,
                      borderRadius: 14,
                      background: visualTheme.surface4,
                      border: `1px solid ${visualTheme.lineRaised}`,
                    }}
                  >
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
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
                ) : (
                  <Identicon
                    address={address}
                    size={52}
                    color={preset}
                    radius={14}
                  />
                )}
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
                      }}
                    />
                  ) : (
                    <Identicon
                      address={top.token}
                      size={40}
                      color={preset}
                      radius={20}
                    />
                  )}
                  <span
                    style={{ fontSize: 34, fontWeight: 600, lineHeight: 1 }}
                  >
                    {top.symbol}
                  </span>
                  <span
                    style={{
                      display: "flex",
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
                  <span
                    style={{
                      fontSize: 30,
                      fontWeight: 600,
                      lineHeight: 1,
                      color: heroColor,
                    }}
                  >
                    {cardEth(w.realizedWei, true)}
                  </span>
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
      {
        width: 1200,
        height: 630,
        fonts: await fonts,
        headers: { "Content-Type": "image/png", "Cache-Control": "no-store" },
      },
    );
    return new Response(await card.arrayBuffer(), {
      headers: { "Content-Type": "image/png", "Cache-Control": "no-store" },
    });
  } catch {
    return new Response("PnL card unavailable. Try again later.", {
      status: 503,
      headers: { "Cache-Control": "no-store", "Retry-After": "300" },
    });
  }
}
