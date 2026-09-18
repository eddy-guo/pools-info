// The trader leaderboard's difference walk and population walk: the top 100
// per window served by two read APIs side by side, how many wallets they
// share, and the top and bottom figure of each. Read-only HTTP; no database
// access, no chain calls, no secrets. Run:
//   node scripts/leaderboard-walk.mjs <old api origin> <new api origin>
// for example the production api against a check api in ledger mode
// (docs/LEDGER-CUTOVER.md). Eight reads in all against the read API's
// 240 reads per minute budget.
const windows = ["24h", "7d", "30d", "All"];
const eth = (wei) =>
  wei === null || wei === undefined
    ? "-"
    : (Number(BigInt(wei) / 10n ** 12n) / 1e6).toFixed(4) + " ETH";
const utc = (seconds) =>
  seconds ? new Date(seconds * 1000).toISOString().replace(".000", "") : "-";
const origin = (input, name) => {
  const url = new URL(input);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw Error(`${name} must be an HTTP origin without credentials or a path`);
  return url;
};
async function board(base, window) {
  const response = await fetch(
    new URL(`/v1/leaderboard?window=${window}&limit=100`, base),
    { signal: AbortSignal.timeout(15000), redirect: "error" },
  );
  if (!response.ok)
    throw Error(
      `${base.host} ${window}: ${response.status} ${await response.text()}`,
    );
  const data = await response.json();
  if (!Array.isArray(data.items) || !Number.isSafeInteger(data.total))
    throw Error(`${base.host} ${window}: not a leaderboard`);
  return data;
}
async function main() {
  const [oldInput, newInput] = process.argv.slice(2);
  if (!oldInput || !newInput)
    throw Error(
      "usage: leaderboard-walk.mjs <old api origin> <new api origin>",
    );
  const bases = { old: origin(oldInput, "old"), new: origin(newInput, "new") };
  const rows = [];
  for (const window of windows) {
    const [before, after] = await Promise.all([
      board(bases.old, window),
      board(bases.new, window),
    ]);
    const addresses = (b) =>
      new Set(b.items.map((i) => i.address.toLowerCase()));
    const shared = [...addresses(before)].filter((a) =>
      addresses(after).has(a),
    );
    const edge = (b, at) => {
      const i = b.items[at];
      return i ? `#${i.rank} ${i.address} ${eth(i.realizedWei)}` : "-";
    };
    rows.push({
      window,
      old: {
        total: before.total,
        shown: before.items.length,
        asOf: utc(before.coverage.asOf),
        pnlScope: before.coverage.pnlScope,
        top: edge(before, 0),
        bottom: edge(before, before.items.length - 1),
      },
      new: {
        total: after.total,
        shown: after.items.length,
        asOf: utc(after.coverage.asOf),
        pnlScope: after.coverage.pnlScope,
        top: edge(after, 0),
        bottom: edge(after, after.items.length - 1),
      },
      shared: shared.length,
      sharedWallets: shared,
    });
  }
  for (const r of rows) {
    console.log(`## ${r.window}`);
    for (const side of ["old", "new"]) {
      const s = r[side];
      console.log(
        `${side}: ${s.shown} of total ${s.total}, asOf ${s.asOf}, ${s.pnlScope}`,
      );
      console.log(`  top    ${s.top}`);
      console.log(`  bottom ${s.bottom}`);
    }
    console.log(`shared: ${r.shared} wallet(s) on both top-100 lists`);
    for (const a of r.sharedWallets) console.log(`  ${a}`);
    console.log();
  }
  console.log(JSON.stringify(rows.map(({ sharedWallets, ...r }) => r)));
}
main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
