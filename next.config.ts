import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  ...(process.env.DOCKER_BUILD === "1" && {output: "standalone" as const}),
  poweredByHeader: false,
};

export default nextConfig;
