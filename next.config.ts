import type { NextConfig } from "next";
import { getConfig } from "./src/config";
import { firebaseAuthProxyRewrites } from "./src/domain/auth-proxy";

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
  // PIN-163: with AUTH_SAME_ORIGIN=1 in optional mode, proxy only
  // Firebase's reserved /__/auth/* sign-in helper paths to the
  // project's firebaseapp host, so the client authDomain can be the
  // app's own host (docs/13-auth.md). Rewrites are computed at
  // build: AUTH_SAME_ORIGIN, AUTH_MODE and FIREBASE_PROJECT_ID must
  // be BUILD-available. Off = an empty list, routing unchanged. Env
  // is read through src/config.ts, the only process.env reader
  // (imported at top level: Next's TS config loader drops its
  // require hook once this file has loaded).
  async rewrites() {
    const cfg = getConfig();
    return firebaseAuthProxyRewrites({
      enabled: cfg.authSameOrigin,
      projectId: cfg.firebaseProjectId,
    });
  },
};

export default nextConfig;
