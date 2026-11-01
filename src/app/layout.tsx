import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { preload } from "react-dom";
import { getConfig } from "../config";
import { resolveAuthUi } from "../domain/auth-ui";
import { DEFAULT_SKIN } from "../domain/skins";
import { t } from "../i18n";
import { LocaleProvider } from "../i18n/client";
import { getLocale } from "../i18n/server";
import { getPolicy } from "../policy/server";
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

const SECONDS_PER_DAY = 24 * 60 * 60;

// The landing's own words (docs/14 Words): the name, the one-liner, what it does.
export async function generateMetadata(): Promise<Metadata> {
  const locale = await getLocale();
  return {
    title: t(locale, "landing.title"),
    description: `${t(locale, "landing.tagline")} ${t(locale, "landing.body")}`,
  };
}

// Mobile-first (docs/14): without this, phones lay out at 980px.
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
export default async function RootLayout({ children }: { children: ReactNode }) {
  const cfg = getConfig();
  // PIN-190 (docs/18-i18n.md): English unless UI_LOCALES turns more on.
  const locale = await getLocale();
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
    <html lang={locale} data-theme={DEFAULT_SKIN}>
      <body>
        <LocaleProvider
          locale={locale}
          enabled={cfg.uiLocales}
          cookieMaxAgeSeconds={getPolicy().localeCookieDays * SECONDS_PER_DAY}
        >
          {ui.enabled ? <AuthProvider config={ui.config}>{children}</AuthProvider> : children}
        </LocaleProvider>
      </body>
    </html>
  );
}
