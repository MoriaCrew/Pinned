"use client";

import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import { DEFAULT_LOCALE, LOCALE_COOKIE, type Locale } from "./locales";

export interface LocaleSettings {
  /** The language this page renders in. */
  locale: Locale;
  /** Languages this deploy offers (UI_LOCALES), English first. */
  enabled: readonly Locale[];
  /** Save a language choice and reload the page in it (switcher, PIN-191). */
  setLocale: (next: Locale) => void;
}

const ENGLISH_ONLY: LocaleSettings = {
  locale: DEFAULT_LOCALE,
  enabled: [DEFAULT_LOCALE],
  setLocale: () => {},
};

// Without a provider (unit tests, /lab), components render English.
const LocaleContext = createContext<LocaleSettings>(ENGLISH_ONLY);

/**
 * Root-layout provider (PIN-190). The server picks the language;
 * the cookie life comes from Policy (localeCookieDays).
 */
export function LocaleProvider({
  locale,
  enabled,
  cookieMaxAgeSeconds,
  children,
}: {
  locale: Locale;
  enabled: readonly Locale[];
  cookieMaxAgeSeconds: number;
  children: ReactNode;
}) {
  const setLocale = useCallback(
    (next: Locale) => {
      if (!enabled.includes(next)) return;
      const secure = window.location.protocol === "https:" ? "; Secure" : "";
      document.cookie = `${LOCALE_COOKIE}=${next}; Path=/; Max-Age=${cookieMaxAgeSeconds}; SameSite=Lax${secure}`;
      window.location.reload();
    },
    [enabled, cookieMaxAgeSeconds],
  );
  const value = useMemo(() => ({ locale, enabled, setLocale }), [locale, enabled, setLocale]);
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

/** The current UI language, for `t(locale, …)` in client components. */
export function useLocale(): Locale {
  return useContext(LocaleContext).locale;
}

/** Language, enabled list and setter, for the switcher. */
export function useLocaleSettings(): LocaleSettings {
  return useContext(LocaleContext);
}
