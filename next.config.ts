import type { NextConfig } from "next";

// PIN-2 scaffold: defaults only. App Hosting serves this app as SSR;
// image/poster work lands with PIN-11 (no remote image hosts until then).
const nextConfig: NextConfig = {
  poweredByHeader: false,
  // PIN-102: the board link card reads its TTF fonts and the static
  // fallback card from disk (process.cwd()); trace them into the
  // server bundle so App Hosting's standalone output ships them.
  outputFileTracingIncludes: {
    "/g/[slug]/opengraph-image": ["./src/server/og-fonts/*.ttf", "./public/og-card.png"],
    "/g/[slug]/twitter-image": ["./src/server/og-fonts/*.ttf", "./public/og-card.png"],
  },
};

export default nextConfig;
