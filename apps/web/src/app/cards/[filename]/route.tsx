import { ImageResponse } from "next/og";
import { reader } from "@/lib/data";
import { formatEth, shortAddress } from "@pools/core";
export const dynamic = "force-static";
export const dynamicParams = false;
export async function generateStaticParams() {
  return (await reader.wallets()).map((w) => ({
    filename: `${w.address}.png`,
  }));
}
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ filename: string }> },
) {
  const { filename } = await params;
  const address = filename.replace(/\.png$/, "");
  const [detail, leaders] = await Promise.all([
    reader.wallet(address),
    reader.leaderboard("7d", 1, 100),
  ]);
  if (!detail) return new Response("Wallet outside snapshot", { status: 404 });
  const rank = leaders.items.findIndex((w) => w.address === address) + 1;
  const summary = detail.summary["7d"];
  return new ImageResponse(
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        width: "100%",
        height: "100%",
        background: "#151216",
        color: "#f4eff3",
        padding: 58,
        fontFamily: "sans-serif",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <div style={{ display: "flex", fontSize: 34, letterSpacing: -1 }}>
          poolsinfo<span style={{ color: "#f2a4ce" }}>.</span>
        </div>
        <div
          style={{
            display: "flex",
            padding: "10px 16px",
            border: "1px solid #745366",
            borderRadius: 8,
            fontSize: 19,
            color: "#f2a4ce",
          }}
        >
          DEMO DATA · NOT REAL RETURNS
        </div>
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginTop: 54,
        }}
      >
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ fontSize: 28 }}>{detail.wallet.label}</div>
          <div style={{ fontSize: 19, color: "#a69da8", marginTop: 9 }}>
            {shortAddress(address)}
          </div>
        </div>
        <div style={{ fontSize: 28, color: "#f2a4ce" }}>
          {rank ? `#${rank} in snapshot` : "Unranked"}
        </div>
      </div>
      <div
        style={{
          display: "flex",
          fontSize: 86,
          marginTop: 27,
          color: BigInt(summary.realizedWei) >= 0n ? "#8bddb6" : "#ed8e9f",
          letterSpacing: -3,
        }}
      >
        {formatEth(summary.realizedWei, true)} ETH
      </div>
      <div style={{ fontSize: 21, color: "#b7acb8" }}>
        7-day realized PnL · instant pools · gas excluded
      </div>
      <div style={{ display: "flex", gap: 55, marginTop: 32, fontSize: 22 }}>
        <span>{summary.trades} eligible trades</span>
        <span>
          {summary.wins}W / {summary.losses}L
        </span>
      </div>
      <div
        style={{
          display: "flex",
          borderTop: "1px solid #41333d",
          paddingTop: 22,
          marginTop: "auto",
          justifyContent: "space-between",
          color: "#b6a5b2",
          fontSize: 17,
        }}
      >
        <span>Simulated snapshot · 14 Sep 2026, 06:00 UTC</span>
        <span>Independent pool analytics</span>
      </div>
    </div>,
    { width: 1200, height: 630, headers: { "Content-Type": "image/png" } },
  );
}
