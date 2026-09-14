import { ImageResponse } from "next/og";
import { walletCaptureLabel, readCardWallet } from "@/lib/product-card";
import { shortAddress, windows, type LiveWindow } from "@pools/core";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;
const money = (wei: string | null) =>
  wei === null
    ? "Unavailable"
    : `${BigInt(wei) > 0n ? "+" : ""}${new Intl.NumberFormat("en-US", { maximumSignificantDigits: 6 }).format(Number(wei) / 1e18)} ETH`;
export async function GET(
  request: Request,
  { params }: { params: Promise<{ filename: string }> },
) {
  const { filename } = await params;
  if (!/^0x[0-9a-f]{40}\.png$/i.test(filename))
    return new Response("Invalid wallet address", { status: 404 });
  const address = filename.slice(0, -4).toLowerCase(),
    q = new URL(request.url).searchParams,
    raw = q.get("window") ?? "All",
    window: LiveWindow = Object.hasOwn(windows, raw)
      ? (raw as LiveWindow)
      : "All";
  try {
    const poolId = q.get("pool")?.toLowerCase(),
      launch = q.get("launch")?.toLowerCase();
    if (
      (poolId && !/^0x[0-9a-f]{64}$/.test(poolId)) ||
      (launch && !/^0x[0-9a-f]{64}$/.test(launch))
    )
      return new Response("Invalid pool scope", { status: 400 });
    const { result, scope, global } = await readCardWallet(
      address,
      window,
      poolId,
      launch,
    );
    const m = result.wallet;
    if (!m.tradeCount)
      return new Response("No trades in the available saved coverage", {
        status: 404,
      });
    const rank = m.rank;
    const image = new ImageResponse(
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          width: "100%",
          height: "100%",
          background: "#0B0B0E",
          color: "#F2F2F5",
          padding: "50px 64px",
          fontFamily: "sans-serif",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <span style={{ fontSize: 30, fontWeight: 600 }}>
              {shortAddress(address).replace("…", "...")}
            </span>
            <span style={{ fontSize: 17, color: "#8A8A94" }}>
              Pools traders / {window === "All" ? "All observed" : window} /
              Robinhood Chain
            </span>
          </div>
          <div style={{ display: "flex", fontSize: 32, fontWeight: 600 }}>
            pools<span style={{ color: "#8A8A94" }}>info</span>
            <span style={{ color: "#4DE1C1" }}>.</span>
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 16,
              marginBottom: 15,
            }}
          >
            <span style={{ color: "#8A8A94", fontSize: 18 }}>
              REALIZED SWAP PNL
            </span>
            <span style={{ color: "#4DE1C1", fontSize: 17 }}>
              {rank
                ? `#${rank} ${global ? "across" : "in"} ${scope}`
                : `Unranked · ${scope}`}
            </span>
          </div>
          <div
            style={{
              display: "flex",
              fontSize: 76,
              fontWeight: 600,
              letterSpacing: -3,
              color:
                m.realizedWei === null || BigInt(m.realizedWei) === 0n
                  ? "#F2F2F5"
                  : BigInt(m.realizedWei) > 0n
                    ? "#3FD68C"
                    : "#FF6169",
            }}
          >
            {money(m.realizedWei)}
          </div>
          <div style={{ display: "flex", gap: 60, marginTop: 25 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <span style={{ color: "#8A8A94", fontSize: 17 }}>
                Realized ROI
              </span>
              <span
                style={{
                  fontSize: 27,
                  color:
                    m.roi === null || m.roi === 0
                      ? "#F2F2F5"
                      : m.roi > 0
                        ? "#3FD68C"
                        : "#FF6169",
                }}
              >
                {m.roi === null
                  ? "N/A"
                  : `${m.roi > 0 ? "+" : ""}${m.roi.toFixed(2)}%`}
              </span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <span style={{ color: "#8A8A94", fontSize: 17 }}>Record</span>
              <span style={{ fontSize: 27 }}>
                {m.realizedWei !== null ? `${m.wins}W / ${m.losses}L` : "N/A"}
              </span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <span style={{ color: "#8A8A94", fontSize: 17 }}>
                Best realized sale
              </span>
              <span
                style={{
                  fontSize: 27,
                  color:
                    m.bestWei === null || BigInt(m.bestWei) === 0n
                      ? "#F2F2F5"
                      : BigInt(m.bestWei) > 0n
                        ? "#3FD68C"
                        : "#FF6169",
                }}
              >
                {money(m.bestWei)}
              </span>
            </div>
          </div>
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 9,
            borderTop: "1px solid #26262E",
            paddingTop: 19,
            color: "#8A8A94",
            fontSize: 15,
          }}
        >
          <span>
            Supported positions {global ? "across" : "in"} {scope}. Average
            cost, before gas.
          </span>
          <span>{walletCaptureLabel(m)}</span>
          <span>{`poolsinfo.com/wallet/${address}/`}</span>
          <span style={{ fontSize: 13 }}>
            {m.excludedPositionCount} unsupported positions excluded.
            {result.delivery.source === "preloaded"
              ? " Preloaded public dataset."
              : " Saved chain data."}
          </span>
        </div>
      </div>,
      {
        width: 1200,
        height: 630,
        headers: { "Content-Type": "image/png", "Cache-Control": "no-store" },
      },
    );
    return new Response(await image.arrayBuffer(), {
      headers: { "Content-Type": "image/png", "Cache-Control": "no-store" },
    });
  } catch {
    return new Response("PnL card unavailable. Try again later.", {
      status: 503,
      headers: { "Cache-Control": "no-store", "Retry-After": "300" },
    });
  }
}
