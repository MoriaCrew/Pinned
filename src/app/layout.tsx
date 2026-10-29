import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { getConfig } from "../config";
import { resolveAuthUi } from "../domain/auth-ui";
import { AuthControl } from "./auth/AuthControl";
import { AuthProvider } from "./auth/AuthProvider";
import "./globals.css";

export const metadata: Metadata = {
  title: "Pinneds — one link, one game, hosted by an AI",
  description:
    "Describe a host in one line, drop the link in your group chat, and play an async photo game. Nothing to install.",
};

// Mobile-first (docs/08): without this, phones lay out at 980px.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

/**
 * Sign-in shell (PIN-84): the provider + header control exist
 * only when resolveAuthUi enables them (AUTH_MODE=optional and
 * the public web config is set — both build-time facts, since
 * NEXT_PUBLIC_* inline at build). Link-only renders exactly the
 * pre-PIN-84 layout: no header, no provider, no auth DOM.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  const cfg = getConfig();
  const ui = resolveAuthUi({
    authMode: cfg.authMode,
    apiKey: cfg.firebaseWebApiKey,
    authDomain: cfg.firebaseWebAuthDomain,
    projectId: cfg.firebaseProjectId,
  });
  return (
    <html lang="en">
      <body>
        {ui.enabled ? (
          <AuthProvider config={ui.config}>
            <header className="site-header">
              <AuthControl />
            </header>
            {children}
          </AuthProvider>
        ) : (
          children
        )}
      </body>
    </html>
  );
}
