// Read-only deployment check. No RPC calls, database access or account secrets.
// Run: node --env-file-if-exists=.env.local scripts/check-indexed-health.mjs
const integer = (v) => Number.isSafeInteger(v) && v >= 0;
const amount = (v) => typeof v === "string" && /^-?\d+$/.test(v);

async function main() {
  const base = new URL(process.env.INDEXER_API_URL ?? "http://127.0.0.1:3102");
  if (
    !["http:", "https:"].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== "/"
  )
    throw Error(
      "INDEXER_API_URL must be an HTTP origin without credentials or a path",
    );

  const checks = [];
  async function read(path) {
    const started = performance.now();
    try {
      const response = await fetch(new URL(path, base), {
        signal: AbortSignal.timeout(10000),
        redirect: "error",
      });
      checks.push({
        path,
        status: response.status,
        elapsedMs: Math.round(performance.now() - started),
      });
      if (!response.ok) return null;
      return await response.json();
    } catch {
      checks.push({ path, error: "Request failed or timed out" });
      return null;
    }
  }
  const [ready, explore, leaderboard, live] = await Promise.all([
    read("/ready"),
    read("/v1/explore?limit=1"),
    read("/v1/leaderboard?limit=1&window=All"),
    read("/v1/live-trades"),
  ]);
  const issues = [];
  if (ready?.ready !== true) issues.push("API readiness failed");
  if (!integer(explore?.total) || !Array.isArray(explore?.items))
    issues.push("Explore response unavailable or invalid");
  if (!integer(leaderboard?.total) || !Array.isArray(leaderboard?.items))
    issues.push("Leaderboard response unavailable or invalid");
  const state = live?.coverage?.state;
  if (
    !["current", "stale", "uninitialized"].includes(state) ||
    !Array.isArray(live?.events)
  )
    issues.push("Recent-trade response unavailable or invalid");
  let consistency = {
    result: "not_checked",
    reason: "No qualifying leaderboard entry",
  };
  const top = leaderboard?.items?.[0];
  if (top) {
    if (!/^0x[\da-f]{40}$/i.test(top.address) || !amount(top.realizedWei)) {
      issues.push("Top trader identity or PnL is invalid");
    } else {
      const profile = await read(`/v1/wallets/${top.address}?window=All`);
      if (!profile?.wallet || !amount(profile.wallet.realizedWei)) {
        issues.push("Top trader profile unavailable or invalid");
      } else {
        const matches = top.realizedWei === profile.wallet.realizedWei;
        consistency = {
          result: matches ? "match" : "recheck_required",
          address: top.address,
          leaderboardWei: top.realizedWei,
          profileWei: profile.wallet.realizedWei,
          reason:
            "Separate requests can observe different publications. This checks one wallet, not all accounting.",
        };
      }
    }
  }
  const asOf = live?.coverage?.asOf;
  console.log(
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        origin: base.origin,
        checks,
        serviceHealthy: issues.length === 0,
        issues,
        catalogPools: explore?.total ?? null,
        processedPools: explore?.coverage?.processedPools ?? null,
        qualifyingTraders: leaderboard?.total ?? null,
        analyticsAsOf: explore?.coverage?.asOf ?? null,
        recent: {
          state: state ?? "unavailable",
          lagBlocks: live?.coverage?.lagBlocks ?? null,
          ageSeconds: integer(asOf)
            ? Math.max(0, Math.floor(Date.now() / 1000) - asOf)
            : null,
        },
        consistency,
        note: "Healthy endpoints do not establish complete launch coverage or complete wallet PnL.",
      },
      null,
      2,
    ),
  );
  process.exitCode = issues.length
    ? 1
    : state !== "current" || consistency.result === "recheck_required"
      ? 2
      : 0;
}
main().catch(() => {
  console.error(
    "Health check failed. Verify INDEXER_API_URL and network access; credentials are not printed.",
  );
  process.exitCode = 1;
});
