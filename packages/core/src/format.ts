export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
// Lossy conversion is for display/chart coordinates only, never accounting.
export function displayEth(wei: string): number {
  return Number(BigInt(wei)) / 1e18;
}
export function formatEth(wei: string, signed = false, digits = 2): string {
  const n = displayEth(wei);
  return `${signed && n > 0 ? "+" : ""}${new Intl.NumberFormat("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(n)}`;
}
export function compact(n: number, digits = 2): string {
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: digits,
  }).format(n);
}
export function formatMoney(
  wei: string,
  currency: "ETH" | "USD",
  ethUsd: number,
  signed = false,
): string {
  const n = displayEth(wei) * (currency === "USD" ? ethUsd : 1);
  const prefix = signed && n > 0 ? "+" : n < 0 ? "-" : "";
  const abs = Math.abs(n);
  return `${prefix}${currency === "USD" ? "$" : ""}${abs >= 1_000_000 ? compact(abs) : new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(abs)}${currency === "ETH" ? " ETH" : ""}`;
}
export function since(timestamp: number, asOf: number): string {
  const seconds = Math.max(0, asOf - timestamp);
  if (seconds < 60) return "<1m";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}
export function sumWei(values: string[]): string {
  return values.reduce((n, v) => n + BigInt(v), 0n).toString();
}
