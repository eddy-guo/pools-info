import type { NextConfig } from "next";

const config: NextConfig = {
  trailingSlash: true,
  images: { unoptimized: true },
  transpilePackages: ["@pools/core", "@pools/chain"],
  serverExternalPackages: ["@envio-dev/hypersync-client"],
};

export default config;
