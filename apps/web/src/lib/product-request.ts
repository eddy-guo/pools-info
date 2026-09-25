import { parseFollowingWallets } from "@pools/core";
const wallet = /^0x[0-9a-f]{40}$/i;
const pool = /^0x[0-9a-f]{64}$/i;
const historyCursor = /^[A-Za-z0-9_-]{1,2048}$/;
export function productRequest(path: string[], input: URLSearchParams) {
  const endpoint = path.join("/");
  const tradeShare =
    path.length === 4 &&
    path[0] === "trades" &&
    pool.test(path[1]) &&
    pool.test(path[2]) &&
    /^(0|[1-9]\d{0,9})$/.test(path[3]) &&
    Number(path[3]) <= 2147483647;
  const ethPrice = endpoint === "prices/eth-usd";
  // The explorer-backed trade history, kept to its one supported kind: this
  // proxy never forwards `transactions` or `token-transfers`, the display-only
  // read the wallet page dropped when its Trades tab was cut.
  const walletTradeHistory =
    path.length === 3 &&
    path[0] === "wallets" &&
    wallet.test(path[1]) &&
    path[2] === "history";
  if (!(
    ["explore", "leaderboard", "search", "following", "creators"].includes(
      endpoint,
    ) ||
    tradeShare ||
    ethPrice ||
    walletTradeHistory ||
    (path.length === 2 &&
      ((path[0] === "wallets" && wallet.test(path[1])) ||
        (path[0] === "pools" && pool.test(path[1]))))
  ))
    throw Error("Invalid product route");
  const output = new URLSearchParams();
  const allowed = tradeShare
    ? ["wallet"]
    : walletTradeHistory
      ? ["kind", "cursor"]
      : endpoint === "following"
        ? ["wallets", "limit"]
        : endpoint === "explore"
          ? ["window", "sort", "direction", "limit", "offset", "q", "view", "ids"]
          : endpoint === "leaderboard"
            ? ["window", "minTrades", "metric", "limit", "offset"]
            : endpoint === "creators"
              ? ["window", "sort", "direction", "limit", "offset"]
              : endpoint === "search"
                ? ["q", "group"]
                : path[0] === "wallets" || path[0] === "pools"
                  ? ["window"]
                  : [];
  for (const [key, value] of input) {
    if (!allowed.includes(key) || input.getAll(key).length !== 1)
      throw Error("Invalid product query");
    if (
      key === "q" &&
      (value.length > 100 || /[\u0000-\u001f\u007f]/.test(value))
    )
      throw Error("Invalid search query");
    if (
      key === "window" &&
      !["1h", "6h", "24h", "7d", "30d", "All"].includes(value)
    )
      throw Error("Invalid window");
    if (
      key === "group" &&
      !["Tokens", "Wallets", "Creators", "Transactions"].includes(value)
    )
      throw Error("Invalid search group");
    if (
      key === "sort" &&
      !(endpoint === "creators"
        ? ["launches", "volume", "median"]
        : ["volume", "trades", "change", "launch", "liquidity"]
      ).includes(value)
    )
      throw Error("Invalid sort");
    if (key === "direction" && !["asc", "desc"].includes(value))
      throw Error("Invalid direction");
    if (key === "metric" && !["realized", "net"].includes(value))
      throw Error("Invalid metric");
    if (
      key === "view" &&
      !["all", "gainers", "new", "watchlist"].includes(value)
    )
      throw Error("Invalid view");
    if (
      ["limit", "offset", "minTrades"].includes(key) &&
      (!/^\d+$/.test(value) ||
        !Number.isSafeInteger(Number(value)) ||
        Number(value) < (key === "limit" ? 1 : 0) ||
        Number(value) >
          (key === "limit" ? 100 : key === "minTrades" ? 999 : 999999))
    )
      throw Error("Invalid pagination");
    if (
      key === "ids" &&
      (value.length > 13400 ||
        value.split(",").length > 200 ||
        (value && value.split(",").some((id) => !pool.test(id))))
    )
      throw Error("Invalid watchlist");
    if (endpoint === "following" && key === "limit" && Number(value) > 50)
      throw Error("Invalid following limit");
    // Only the trades kind is served here: the transactions and token-transfers
    // kinds this route also supports upstream have no page on the site.
    if (key === "kind" && value !== "trades") throw Error("Invalid history kind");
    if (key === "cursor" && !historyCursor.test(value))
      throw Error("Invalid history cursor");
    if (key === "wallets") {
      output.set(key, parseFollowingWallets(value).join(","));
      continue;
    }
    if (key === "wallet") {
      if (!wallet.test(value)) throw Error("Invalid trade wallet");
      output.set(key, value.toLowerCase());
      continue;
    }
    output.set(
      key,
      ["limit", "offset", "minTrades"].includes(key)
        ? String(Number(value))
        : value,
    );
  }
  if (tradeShare && !output.has("wallet"))
    throw Error("A trade wallet is required");
  if (walletTradeHistory && output.get("kind") !== "trades")
    throw Error("A history kind is required");
  return { endpoint: endpoint.toLowerCase(), params: output };
}
