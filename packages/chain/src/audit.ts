import {
  decodeEventLog,
  decodeFunctionResult,
  encodeFunctionData,
  erc20Abi,
  toEventSelector,
  type Hex,
} from "viem";
import {
  reconcileWallets,
  type ObservedExecution,
  type TokenMovement,
  type ChainTrade,
  type Address,
} from "@pools/core";
import {
  contracts,
  decodeSwap,
  swapEvent,
  transferEvent,
  type RawLog,
} from "./events";
import { Rpc, hex } from "./rpc";

export interface Receipt {
  status: Hex;
  from: Hex;
  to: Hex | null;
  blockHash: Hex;
  logs: RawLog[];
  transactionHash: Hex;
}
export function attributeSwap(
  log: RawLog,
  receipt: Receipt,
  token: string,
  senderCode: string,
) {
  const decoded = decodeSwap(log);
  const flags: string[] = [];
  if (
    receipt.status !== "0x1" ||
    receipt.blockHash !== log.blockHash ||
    receipt.transactionHash !== log.transactionHash ||
    !receipt.logs.some(
      (entry) =>
        entry.logIndex === log.logIndex &&
        entry.address.toLowerCase() === log.address.toLowerCase() &&
        entry.data.toLowerCase() === log.data.toLowerCase() &&
        entry.topics.join().toLowerCase() === log.topics.join().toLowerCase(),
    )
  )
    throw Error("Receipt does not match canonical swap");
  if (senderCode !== "0x") flags.push("contract_sender");
  if (
    receipt.to?.toLowerCase() !== contracts.router ||
    decoded.sender.toLowerCase() !== contracts.router
  )
    flags.push("unsupported_route");
  const swaps = receipt.logs.filter(
    (l) =>
      l.address.toLowerCase() === contracts.manager &&
      l.topics[0] === toEventSelector(swapEvent),
  );
  if (swaps.length !== 1) flags.push("multiple_swap_route");
  const movements = receipt.logs
    .filter(
      (l) =>
        l.address.toLowerCase() === token.toLowerCase() &&
        l.topics[0] === toEventSelector(transferEvent),
    )
    .map((l) => ({
      log: l,
      args: decodeEventLog({ abi: [transferEvent], ...l, strict: true }).args,
    }));
  const sender = receipt.from.toLowerCase();
  const own = movements.filter(
    (m) =>
      m.args.value > 0n &&
      (m.args.from.toLowerCase() === sender ||
        m.args.to.toLowerCase() === sender),
  );
  const match =
    own.length === 1 &&
    own[0].args.value === BigInt(decoded.tokenRaw) &&
    own[0].args.from.toLowerCase() ===
      (decoded.side === "buy" ? contracts.manager : sender) &&
    own[0].args.to.toLowerCase() ===
      (decoded.side === "buy" ? sender : contracts.manager);
  if (!match) flags.push("token_flow_mismatch");
  return {
    sender: receipt.from.toLowerCase() as Address,
    flags,
    matchedTransfer: match
      ? `${own[0].log.transactionHash}:${own[0].log.logIndex}`
      : null,
  };
}

export async function auditPool(args: {
  rpc: Rpc;
  token: Hex;
  rawSwaps: RawLog[];
  transfers: RawLog[];
  trades: ChainTrade[];
  toBlock: number;
  tokenBornAtLaunch: boolean;
  receipt: (hash: Hex) => Promise<Receipt>;
  code: (address: Hex) => Promise<Hex>;
}) {
  const { rpc, token, rawSwaps, transfers, trades, toBlock } = args;
  const executions: ObservedExecution[] = [];
  for (let i = 0; i < rawSwaps.length; i += 4) {
    executions.push(
      ...(await Promise.all(
        rawSwaps.slice(i, i + 4).map(async (log) => {
          const receipt = await args.receipt(log.transactionHash);
          const result = attributeSwap(
            log,
            receipt,
            token,
            await args.code(receipt.from),
          );
          if (!args.tokenBornAtLaunch)
            result.flags.push("unverified_token_birth");
          const trade = trades.find(
            (t) =>
              t.txHash === log.transactionHash &&
              t.logIndex === Number(log.logIndex),
          )!;
          return {
            trade: {
              ...trade,
              id: `${trade.txHash}:${trade.logIndex}`,
              txHash: trade.txHash as Address,
              poolId: trade.poolId as Address,
              trader: result.sender,
            },
            flags: result.flags,
            matchedTransfer: result.matchedTransfer,
          };
        }),
      )),
    );
  }
  const movements: TokenMovement[] = transfers.map((log) => {
    const { args } = decodeEventLog({
      abi: [transferEvent],
      ...log,
      strict: true,
    });
    return {
      id: `${log.transactionHash}:${log.logIndex}`,
      from: args.from.toLowerCase(),
      to: args.to.toLowerCase(),
      value: args.value.toString(),
    };
  });
  const addresses = [...new Set(executions.map((e) => e.trade.trader))];
  const balances = new Map<string, string>();
  const results = await rpc.batch<Hex>(
    "eth_call",
    addresses.map((address) => [
      {
        to: token,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [address],
        }),
      },
      hex(toBlock),
    ]),
  );
  results.forEach((data, i) =>
    balances.set(
      addresses[i],
      decodeFunctionResult({
        abi: erc20Abi,
        functionName: "balanceOf",
        data,
      }).toString(),
    ),
  );
  return {
    executions,
    wallets: reconcileWallets(executions, movements, balances),
    unattributedSwaps: executions.filter((e) => e.flags.length).length,
    transfersChecked: transfers.length,
  };
}
