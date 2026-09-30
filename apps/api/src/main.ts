import { createReader } from "./reader";
import { ledgerStaleSetting } from "./ledger-freshness";
import { marketSourceSetting } from "./ledger-market";
import { createApi } from "./server";
import { identitySources, ingressSettings } from "./ingress";
import {
  createTokenImageService,
  createTokenImageStore,
  tokenImageSettings,
} from "./token-image-store";
import { createTokenRegistry } from "./token-registry";
import {
  blockscoutClientFromEnv,
  createWalletHistoryFromEnv,
} from "./wallet-history";
import { createFollowing } from "./following-read";
import {
  createContractCensus,
  createWalletCodeStore,
} from "./trader-contracts";

const port = Number(process.env.PORT ?? "3102");
if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
  throw Error("Invalid PORT");
// Read once at startup: an unset MARKET_SOURCE serves the broad rollups.
const marketSource = marketSourceSetting(process.env.MARKET_SOURCE);
// Who a client is, and what it may spend, is the ingress contract
// (apps/api/README.md, "Request limits and client identity").
const ingress = ingressSettings(process.env);
const reader = createReader(undefined, undefined, {
  marketSource,
  warmup: true,
  // Read once at startup, with the collector's own default.
  staleMs: ledgerStaleSetting(process.env),
});
const images = createTokenImageService(createTokenImageStore(), {
  settings: tokenImageSettings(),
});
// One registry and one explorer cache serve the wallet page's trades and
// Following, so a wallet read by either is not paid for twice.
const registry = createTokenRegistry((afterRef) =>
  reader.registeredTokens!(afterRef),
);
// One explorer client, so one daily credit budget, for every explorer read.
const explorer = blockscoutClientFromEnv(process.env);
const history = createWalletHistoryFromEnv(process.env, registry, explorer);
// The trader board's contract census reads code only for the board the
// ledger serves (docs/LEDGER-MARKET-SERVING.md, "The trader leaderboard").
const census =
  marketSource === "ledger" && explorer
    ? createContractCensus({ store: createWalletCodeStore(), client: explorer })
    : null;
census?.start();
const server = createApi(reader, {
  images,
  history,
  ingress,
  following: createFollowing({
    history,
    registry,
    activity: (wallets) => reader.walletActivity!(wallets),
  }),
});
server.listen(port, "0.0.0.0", () =>
  process.stdout.write(
    JSON.stringify({
      event: "listening",
      port,
      marketSource,
      clientIdentity: identitySources(ingress.identity),
    }) + "\n",
  ),
);
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    const timeout = setTimeout(() => process.exit(1), 10000);
    timeout.unref();
    server.close(() => {
      void Promise.all([reader.close(), images.close(), census?.close()]).then(
        () => {
          clearTimeout(timeout);
          process.exit(0);
        },
        () => process.exit(1),
      );
    });
  });
