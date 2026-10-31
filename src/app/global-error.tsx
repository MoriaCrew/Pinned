"use client";

import { useSyncExternalStore } from "react";
import { DEFAULT_LOCALE, localeFromDocument } from "../i18n/locales";
import { ErrorScreen } from "./ErrorScreen";
// The root layout is what failed, so its stylesheets may not be on
// the page: load the same ones here (CSS only, no scripts).
import "../ui/tokens.css";
import "../ui/pinneds.css";
import "./globals.css";

// Without the root layout there is no LocaleProvider and no router.
// The language comes from the browser instead (saved choice, else
// the page's own lang). The server render has no document, so it
// says English and the client swaps once it hydrates.
const subscribe = () => () => {};
const clientLocale = () => localeFromDocument(document.cookie, document.documentElement.lang);
const serverLocale = () => DEFAULT_LOCALE;

/**
 * Last-resort boundary (PIN-212): the root layout itself threw, so
 * this file renders its own <html> and <body>. A full reload is the
 * retry: Next's `reset()` cannot refetch a failed layout, and there
 * is no router context out here to refresh.
 */
export default function GlobalError() {
  const locale = useSyncExternalStore(subscribe, clientLocale, serverLocale);
  return (
    <html lang={locale} data-theme="paper">
      <body>
        <ErrorScreen locale={locale} onRetry={() => window.location.reload()} />
      </body>
    </html>
  );
}
