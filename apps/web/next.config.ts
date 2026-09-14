import type { NextConfig } from "next";

const config: NextConfig = {
  trailingSlash: true,
  images: { unoptimized: true },
  transpilePackages: ["@pools/core", "@pools/chain"],
};

export default config;
