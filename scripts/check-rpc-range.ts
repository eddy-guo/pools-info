import { Rpc, contracts, type RawLog } from "@pools/chain";

// Direct call, intentionally not Rpc.logs(): automatic range fallback would
// hide whether a plan upgrade actually permits the requested larger range.
async function main() {
  if (!process.env.ROBINHOOD_RPC_URL)
    throw Error("ROBINHOOD_RPC_URL is required");
  const rpc = new Rpc(process.env.ROBINHOOD_RPC_URL, {
    timeoutMs: 15000,
    maxRequests: 8,
    minIntervalMs: 1000,
  });
  if (Number(await rpc.call<string>("eth_chainId", [])) !== 4663)
    throw Error("Wrong chain");
  const head = Number(await rpc.call<string>("eth_blockNumber", []));
  if (!Number.isSafeInteger(head) || head < 1127)
    throw Error("Invalid chain head");
  const to = head - 128,
    from = to - 999;
  const logs = await rpc.call<RawLog[]>("eth_getLogs", [
    {
      address: contracts.strategies,
      topics: [],
      fromBlock: `0x${from.toString(16)}`,
      toBlock: `0x${to.toString(16)}`,
    },
  ]);
  if (
    !Array.isArray(logs) ||
    logs.some(
      (l) =>
        l.removed ||
        !contracts.strategies.some((a) => a === l.address.toLowerCase()) ||
        !Number.isSafeInteger(Number(l.blockNumber)) ||
        Number(l.blockNumber) < from ||
        Number(l.blockNumber) > to,
    )
  )
    throw Error("Invalid range response");
  console.log(
    JSON.stringify(
      {
        chainId: 4663,
        requestedBlocks: 1000,
        acceptsRequestedRange: true,
        returnedLogs: logs.length,
        note: "Read-only range check. This does not verify account throughput, pricing or complete launch coverage.",
      },
      null,
      2,
    ),
  );
}
main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "";
  const match = /^RPC log range limited to (\d+) blocks$/.exec(message);
  if (match) {
    console.log(
      JSON.stringify(
        {
          requestedBlocks: 1000,
          acceptsRequestedRange: false,
          advertisedBlockLimit: Number(match[1]),
          note: "No fallback queries or configuration changes were made.",
        },
        null,
        2,
      ),
    );
    process.exitCode = 2;
  } else {
    const safe =
      /^(RPC HTTP \d{3}|Wrong chain|Invalid chain head|Invalid range response|ROBINHOOD_RPC_URL is required)$/.test(
        message,
      )
        ? message
        : "RPC range check failed";
    console.error(JSON.stringify({ error: safe }));
    process.exitCode = 1;
  }
});
