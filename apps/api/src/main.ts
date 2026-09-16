import { createReader } from "./reader";
import { createApi } from "./server";
import {
  createTokenImageService,
  createTokenImageStore,
  tokenImageSettings,
} from "./token-image-store";

const port = Number(process.env.PORT ?? "3102");
if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
  throw Error("Invalid PORT");
const reader = createReader();
const images = createTokenImageService(createTokenImageStore(), {
  settings: tokenImageSettings(),
});
const server = createApi(reader, { images });
server.listen(port, "0.0.0.0", () =>
  process.stdout.write(JSON.stringify({ event: "listening", port }) + "\n"),
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
