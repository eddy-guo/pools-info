import type { WalletPositionResponse } from "@pools/core";
import { validLaunchType } from "./explore-response";

const integer = (n: unknown) => Number.isSafeInteger(n) && Number(n) >= 0;
const amount = (n: unknown) =>
  typeof n === "string" && /^(0|[1-9][0-9]{0,159})$/.test(n);
const signedAmount = (n: unknown) =>
  typeof n === "string" && /^(0|-?[1-9][0-9]{0,159})$/.test(n);
const nullable = (check: (n: unknown) => boolean) => (n: unknown) =>
  n === null || check(n);
const hex = (n: unknown, bytes: number) =>
  typeof n === "string" && new RegExp(`^0x[0-9a-f]{${bytes * 2}}$`).test(n);

/**
 * The single-position read (`GET /v1/wallets/:address/positions/:poolId`) as
 * a position card may draw it: the requested wallet and pool, one catalog
 * identity for the pool and the row, and every figure the card prints in its
 * served form. A body that fails any of it is no card, never a partial one.
 */
export function validatePositionResponse(
  value: unknown,
  wallet: string,
  poolId: string,
): asserts value is WalletPositionResponse {
  const data = value as WalletPositionResponse | null;
  const pool = data?.pool,
    row = data?.position,
    p = row?.position,
    mark = data?.mark;
  if (
    !data ||
    typeof data !== "object" ||
    !data.coverage ||
    data.window !== "All" ||
    data.wallet !== wallet ||
    !pool ||
    pool.id !== poolId ||
    !hex(pool.token, 20) ||
    !hex(pool.launchTx, 32) ||
    typeof pool.name !== "string" ||
    typeof pool.symbol !== "string" ||
    !validLaunchType(pool.launchType) ||
    !row ||
    row.poolId !== poolId ||
    row.token !== pool.token ||
    row.launchTx !== pool.launchTx ||
    typeof row.symbol !== "string" ||
    !nullable(integer)(row.decimals) ||
    !integer(row.asOf) ||
    typeof row.supported !== "boolean" ||
    !Array.isArray(row.flags) ||
    !nullable(signedAmount)(row.realizedWei) ||
    !nullable(signedAmount)(row.unrealizedWei) ||
    !amount(row.volumeWei) ||
    !nullable(amount)(data.avgEntryPriceWei) ||
    (mark !== null &&
      (!mark ||
        typeof mark !== "object" ||
        !nullable(amount)(mark.priceWei) ||
        !nullable(amount)(mark.valueWei)))
  )
    throw Error("Invalid position");
  if (p === null) return;
  if (
    !p ||
    p.poolId !== poolId ||
    p.trader !== wallet ||
    !amount(p.quantity) ||
    !amount(p.costWei) ||
    !amount(p.investedWei) ||
    !amount(p.proceedsWei) ||
    !nullable(signedAmount)(p.realizedWei) ||
    !integer(p.buys) ||
    !integer(p.sells) ||
    !nullable(integer)(p.openedAt ?? null)
  )
    throw Error("Invalid position state");
}
