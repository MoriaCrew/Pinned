import type { NextConfig } from "next";

// PIN-2 scaffold: defaults only. App Hosting serves this app as SSR;
// image/poster work lands with PIN-11 (no remote image hosts until then).
const nextConfig: NextConfig = {
  poweredByHeader: false,
  // PIN-102: the board link card reads its TTF fonts and the static
  // fallback card from disk (process.cwd()); trace them into the
  // server bundle so App Hosting's standalone output ships them.
  // Never trace anything from ./public (PIN-116): it pre-creates
  // .next/standalone/public, and App Hosting's adapter (<= 14.0.21)
  // then skips copying public/ entirely, so fonts and images 404.
  outputFileTracingIncludes: {
    "/g/[slug]/opengraph-image": ["./src/server/og-fonts/*.ttf", "./src/server/og-assets/*.png"],
    "/g/[slug]/twitter-image": ["./src/server/og-fonts/*.ttf", "./src/server/og-assets/*.png"],
  },
};

export default nextConfig;
