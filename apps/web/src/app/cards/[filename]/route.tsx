import { ImageResponse } from "next/og";
import { auditedPoolSnapshot } from "@/lib/chain-server";
import { initialSnapshot } from "@/lib/data";
import {
  shortAddress,
  walletMetrics,
  windows,
  type LiveWindow,
  type PoolAudit,
} from "@pools/core";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 240;
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
    pool = q.get("pool"),
    launch = q.get("launch"),
    raw = q.get("window") ?? "All",
    window: LiveWindow = Object.hasOwn(windows, raw)
      ? (raw as LiveWindow)
      : "All";
  if (
    !pool ||
    !/^0x[0-9a-f]{64}$/i.test(pool) ||
    !launch ||
    !/^0x[0-9a-f]{64}$/i.test(launch)
  )
    return new Response(
      "Open a wallet profile with a selected pool to generate its audit card.",
      { status: 400 },
    );
  try {
    // Offline tests may use a committed RPC-audited snapshot, never request-supplied metrics.
    const snapshot =
      process.env.CHAIN_REFRESH_DISABLED === "1"
        ? initialSnapshot
        : await auditedPoolSnapshot(
            pool.toLowerCase(),
            launch as `0x${string}`,
          );
    const market = snapshot.markets.find((m) => m.id === pool.toLowerCase());
    if (!market?.accounting?.executions)
      return new Response("Audit unavailable. Try again later.", {
        status: 503,
        headers: { "Cache-Control": "no-store" },
      });
    const audit: PoolAudit = {
      poolId: market.id,
      market,
      toBlock: snapshot.toBlock,
      toTimestamp: snapshot.toTimestamp,
      generatedAt: snapshot.generatedAt,
      ...market.accounting,
      executions: market.accounting.executions,
    };
    const m = walletMetrics(audit, address, window);
    if (!m)
      return new Response("No attributed swaps for this wallet in this pool", {
        status: 404,
      });
    const ranked = audit.wallets
      .map((w) => walletMetrics(audit, w.address, window)!)
      .filter((w) => w.complete && w.trades.length >= 10)
      .sort((a, b) =>
        BigInt(a.realizedWei!) > BigInt(b.realizedWei!)
          ? -1
          : BigInt(a.realizedWei!) < BigInt(b.realizedWei!)
            ? 1
            : a.row.address.localeCompare(b.row.address),
      );
    const rank =
      ranked.findIndex((w) => w.row.address.toLowerCase() === address) + 1;
    // Contract names can include unsupported glyphs. Keep OG text ASCII to avoid remote glyph loading.
    const symbol =
      market.symbol.replace(/[^\x20-\x7e]/g, "").slice(0, 24) || "Token";
    const image = new ImageResponse(
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          width: "100%",
          height: "100%",
          background: "#151216",
          color: "#f4eff3",
          padding: 52,
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
          <span style={{ fontSize: 36, color: "#f2a4ce" }}>poolsinfo.</span>
          <span style={{ fontSize: 20, color: "#b7acb8" }}>
            ON-CHAIN AUDIT / ROBINHOOD
          </span>
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            marginTop: 42,
            fontSize: 30,
          }}
        >
          <span>{shortAddress(address).replace("…", "...")}</span>
          <span style={{ color: "#f2a4ce" }}>
            {rank ? `#${rank} in this pool` : "Unranked"}
          </span>
        </div>
        <div
          style={{
            display: "flex",
            fontSize: 70,
            marginTop: 25,
            color:
              m.realizedWei === null
                ? "#b7acb8"
                : BigInt(m.realizedWei) >= 0n
                  ? "#8bddb6"
                  : "#ed8e9f",
          }}
        >
          {money(m.realizedWei)}
        </div>
        <div
          style={{
            display: "flex",
            fontSize: 22,
            marginTop: 12,
          }}
        >
          {window} realized swap PnL - {symbol} only - before gas
        </div>
        <div style={{ display: "flex", gap: 40, marginTop: 25, fontSize: 23 }}>
          <span>ROI {m.roi === null ? "N/A" : m.roi.toFixed(2) + "%"}</span>
          <span>{m.complete ? `${m.wins}W / ${m.losses}L` : "Record N/A"}</span>
          <span>{m.trades.length} observed swaps</span>
        </div>
        <div
          style={{
            display: "flex",
            fontSize: 22,
            marginTop: 18,
            color: "#b7acb8",
          }}
        >
          Best realized sale: {money(m.bestWei)}
        </div>
        <div
          style={{
            display: "flex",
            fontSize: 17,
            marginTop: 20,
            color: "#b7acb8",
          }}
        >
          Not wallet-wide returns. Average cost. Unsupported or unknown basis is
          excluded.
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            borderTop: "1px solid #41333d",
            paddingTop: 17,
            marginTop: "auto",
            gap: 8,
            fontSize: 16,
            color: "#b7acb8",
          }}
        >
          <span>
            Block {audit.toBlock} -{" "}
            {new Date(audit.toTimestamp * 1000)
              .toISOString()
              .slice(0, 19)
              .replace("T", " ")}{" "}
            UTC
          </span>
          <span>{`poolsinfo.com/wallet/${address}/`}</span>
          <span>{`Pool ${market.id}`}</span>
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
    return new Response("Audit card unavailable. Try again later.", {
      status: 503,
      headers: { "Cache-Control": "no-store", "Retry-After": "300" },
    });
  }
}
