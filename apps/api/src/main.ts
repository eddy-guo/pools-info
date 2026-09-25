import { createReader } from "./reader";
import { marketSourceSetting } from "./ledger-market";
import { createApi } from "./server";
import {
  createTokenImageService,
  createTokenImageStore,
  tokenImageSettings,
} from "./token-image-store";
import { createTokenRegistry } from "./token-registry";
import { createWalletHistoryFromEnv } from "./wallet-history";
import { createFollowing } from "./following-read";

const port = Number(process.env.PORT ?? "3102");
if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
  throw Error("Invalid PORT");
// Read once at startup: an unset MARKET_SOURCE serves the broad rollups.
const marketSource = marketSourceSetting(process.env.MARKET_SOURCE);
const reader = createReader(undefined, undefined, {
  marketSource,
  warmup: true,
});
const images = createTokenImageService(createTokenImageStore(), {
  settings: tokenImageSettings(),
});
// One registry and one explorer cache serve the wallet page's trades and
// Following, so a wallet read by either is not paid for twice.
const registry = createTokenRegistry((afterRef) =>
  reader.registeredTokens!(afterRef),
);
const history = createWalletHistoryFromEnv(process.env, registry);
const server = createApi(reader, {
  images,
  history,
  following: createFollowing({
    history,
    registry,
    activity: (wallets) => reader.walletActivity!(wallets),
  }),
});
server.listen(port, "0.0.0.0", () =>
  process.stdout.write(
    JSON.stringify({ event: "listening", port, marketSource }) + "\n",
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
      void Promise.all([reader.close(), images.close()]).then(
        () => {
          clearTimeout(timeout);
          process.exit(0);
        },
        () => process.exit(1),
      );
    });
  });
