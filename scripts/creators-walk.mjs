// The creators leaderboard's population walk: the top 100 by launches and by
// volume served by two read APIs side by side, the launches and measured
// columns of each row, how many rows' measured figures differ, and whether
// the order and the Launches column moved. Read-only HTTP; no database
// access, no chain calls, no secrets. Run:
//   node scripts/creators-walk.mjs <old api origin> <new api origin> [n]
// for example a check api in broad mode against one in ledger mode on the
// same database (docs/LEDGER-CUTOVER.md), printing the top n rows (10) in
// full. Four reads in all against the read API's 240 reads per minute budget.
const sorts = ["launches", "volume"];
const eth = (wei) =>
  wei === null || wei === undefined
    ? "-"
    : (Number(BigInt(wei) / 10n ** 12n) / 1e6).toFixed(4) + " ETH";
const short = (address) => address.slice(0, 6) + "…" + address.slice(-4);
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
async function board(base, sort) {
  const response = await fetch(
    new URL(`/v1/creators?sort=${sort}&limit=100`, base),
    { signal: AbortSignal.timeout(15000), redirect: "error" },
  );
  if (!response.ok)
    throw Error(
      `${base.host} ${sort}: ${response.status} ${await response.text()}`,
    );
  const data = await response.json();
  if (!Array.isArray(data.items) || !Number.isSafeInteger(data.total))
    throw Error(`${base.host} ${sort}: not a creators board`);
  return data;
}
const measured = (r) => ({
  measured: r.measured,
  traded: r.traded,
  volumeWei: r.volumeWei,
  medianVolumeWei: r.medianVolumeWei,
  bestLaunch: r.bestLaunch?.id ?? null,
  boughtOwnLaunch: r.boughtOwnLaunch,
});
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const cell = (r) =>
  r
    ? `${r.measured} of ${r.launches} · ${r.traded} traded · ${eth(r.volumeWei)} · median ${eth(r.medianVolumeWei)} · best ${r.bestLaunch ? r.bestLaunch.symbol : "-"} ${eth(r.bestLaunch?.volumeWei)} · own ${r.boughtOwnLaunch ?? "-"}`
    : "not on this board";
async function main() {
  const [oldInput, newInput, top = "10"] = process.argv.slice(2);
  if (!oldInput || !newInput)
    throw Error(
      "usage: creators-walk.mjs <old api origin> <new api origin> [n]",
    );
  const bases = { old: origin(oldInput, "old"), new: origin(newInput, "new") };
  const n = Number(top);
  for (const sort of sorts) {
    const [before, after] = await Promise.all([
      board(bases.old, sort),
      board(bases.new, sort),
    ]);
    const byAddress = (b) => new Map(b.items.map((r) => [r.address, r]));
    const oldRows = byAddress(before),
      newRows = byAddress(after);
    const shared = before.items.filter((r) => newRows.has(r.address));
    const changed = shared.filter(
      (r) => !same(measured(r), measured(newRows.get(r.address))),
    );
    const sameOrder = same(
      before.items.map((r) => r.address),
      after.items.map((r) => r.address),
    );
    const sameLaunches = shared.every(
      (r) => r.launches === newRows.get(r.address).launches,
    );
    const rankByLaunches = (b) => b.items.map((r) => r.launches);
    console.log(`## sort=${sort}, window=All, top 100\n`);
    console.log(
      `- old total ${before.total}, new total ${after.total}; ${shared.length} of the old 100 are on the new board; the address order is ${sameOrder ? "identical" : "NOT identical"}${
        sort === "launches"
          ? `, the Launches column is ${sameLaunches ? "identical" : "NOT identical"} on every shared row, and the launch counts down the board are ${same(rankByLaunches(before), rankByLaunches(after)) ? "identical" : "NOT identical"}`
          : ""
      }.`,
    );
    console.log(
      `- measured columns (measured, traded, volumeWei, medianVolumeWei, bestLaunch, boughtOwnLaunch) differ on ${changed.length} of the ${shared.length} shared rows; measured rows old ${before.items.filter((r) => r.measured > 0).length}, new ${after.items.filter((r) => r.measured > 0).length}; measured launches summed over the board old ${before.items.reduce((s, r) => s + r.measured, 0)}, new ${after.items.reduce((s, r) => s + r.measured, 0)} of ${after.items.reduce((s, r) => s + r.launches, 0)} launches; own-buy true old ${before.items.filter((r) => r.boughtOwnLaunch === true).length}, new ${after.items.filter((r) => r.boughtOwnLaunch === true).length}.\n`,
    );
    console.log(`| # | creator | old | new |\n|---|---|---|---|`);
    const listed = sort === "launches" ? before.items : after.items;
    listed.slice(0, n).forEach((r, i) => {
      const other =
        sort === "launches" ? newRows.get(r.address) : oldRows.get(r.address);
      const [o, w] = sort === "launches" ? [r, other] : [other, r];
      console.log(
        `| ${i + 1} | ${short(r.address)} | ${cell(o)} | ${cell(w)} |`,
      );
    });
    console.log("");
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
