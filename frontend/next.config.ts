import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const here = path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  devIndicators: false,
  // This app sits inside a monorepo (../api is a separate Python service and
  // ../specs holds docs). Without an explicit root, Turbopack detects the
  // parent and warns on every build. Pin it to this app so only ghost/ is
  // watched and traced.
  turbopack: {
    root: here,
  },
};

export default nextConfig;