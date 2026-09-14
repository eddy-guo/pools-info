const wallet = /^0x[0-9a-f]{40}$/i;
const pool = /^0x[0-9a-f]{64}$/i;
export function productRequest(path: string[], input: URLSearchParams) {
  const endpoint = path.join("/");
  if (!(
    ["explore", "leaderboard", "search"].includes(endpoint) ||
    (path.length === 2 &&
      ((path[0] === "wallets" && wallet.test(path[1])) ||
        (path[0] === "pools" && pool.test(path[1]))))
  ))
    throw Error("Invalid product route");
  const output = new URLSearchParams();
  const allowed =
    endpoint === "explore"
      ? ["window", "sort", "direction", "limit", "offset", "q", "view", "ids"]
      : endpoint === "leaderboard"
        ? ["window", "minTrades", "metric", "limit", "offset"]
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
      !["volume", "change", "launch", "liquidity"].includes(value)
    )
      throw Error("Invalid sort");
    if (key === "direction" && !["asc", "desc"].includes(value))
      throw Error("Invalid direction");
    if (key === "metric" && !["realized", "net"].includes(value))
      throw Error("Invalid metric");
    if (
      key === "view" &&
      !["all", "gainers", "new", "crowd", "watchlist"].includes(value)
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
    output.set(
      key,
      ["limit", "offset", "minTrades"].includes(key)
        ? String(Number(value))
        : value,
    );
  }
  return { endpoint: endpoint.toLowerCase(), params: output };
}
