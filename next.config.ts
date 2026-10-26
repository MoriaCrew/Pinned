import type { NextConfig } from "next";

// PIN-2 scaffold: defaults only. App Hosting serves this app as SSR;
// image/poster work lands with PIN-11 (no remote image hosts until then).
const nextConfig: NextConfig = {
  poweredByHeader: false,
};

export default nextConfig;
