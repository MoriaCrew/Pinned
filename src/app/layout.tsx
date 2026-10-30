import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { preload } from "react-dom";
import { getConfig } from "../config";
import { resolveAuthUi } from "../domain/auth-ui";
import { DEFAULT_SKIN } from "../domain/skins";
import { t } from "../i18n";
import { AuthProvider } from "./auth/AuthProvider";
// Tokens, then components, then the small global reset (docs/14).
import "../ui/tokens.css";
import "../ui/pinneds.css";
import "./globals.css";

/** Faces every page uses: the reading face and the default display face. */
const PRELOADED_FONTS = [
  "/fonts/AtkinsonHyperlegibleNext-200-800.woff2",
  "/fonts/BricolageGrotesque-200-800.woff2",
];

// The landing's own words (docs/14 Words): the name, the one-liner, what it does.
export const metadata: Metadata = {
  title: t("en", "landing.title"),
  description: `${t("en", "landing.tagline")} ${t("en", "landing.body")}`,
};

// Mobile-first (docs/08): without this, phones lay out at 980px.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

/**
 * Sign-in shell (PIN-84): the provider exists only when
 * resolveAuthUi enables it (AUTH_MODE=optional and the public web
 * config is set — both build-time facts, since NEXT_PUBLIC_*
 * inline at build). No bar of its own (PIN-120): each page's
 * header carries the "you" button. Link-only renders no provider
 * and no auth DOM.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  const cfg = getConfig();
  const ui = resolveAuthUi({
    authMode: cfg.authMode,
    apiKey: cfg.firebaseWebApiKey,
    authDomain: cfg.firebaseWebAuthDomain,
    projectId: cfg.firebaseProjectId,
  });
  for (const href of PRELOADED_FONTS) {
    preload(href, { as: "font", type: "font/woff2", crossOrigin: "anonymous" });
  }
  return (
    <html lang="en" data-theme={DEFAULT_SKIN}>
      <body>
        {ui.enabled ? <AuthProvider config={ui.config}>{children}</AuthProvider> : children}
      </body>
    </html>
  );
}
