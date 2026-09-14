import type { NextConfig } from "next";

const config: NextConfig = {
  trailingSlash: true,
  redirects: () => [{ source: "/live/", destination: "/", permanent: false }],
  images: { unoptimized: true },
  transpilePackages: ["@pools/core", "@pools/chain"],
};

export default config;
