import "server-only";
import { cookies, headers } from "next/headers";
import { getConfig } from "../config";
import { DEFAULT_LOCALE, LOCALE_COOKIE, negotiateLocale, type Locale } from "./locales";

/**
 * The request's UI language (PIN-190): saved choice → Accept-Language
 * → English, limited to UI_LOCALES. Works in server components,
 * generateMetadata and route handlers.
 *
 * With English as the only language (the default) it never reads the
 * request, so pages stay exactly as they were, static ones included.
 */
export async function getLocale(): Promise<Locale> {
  const enabled = getConfig().uiLocales;
  if (enabled.length <= 1) return DEFAULT_LOCALE;
  const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);
  return negotiateLocale({
    cookie: cookieStore.get(LOCALE_COOKIE)?.value,
    acceptLanguage: headerStore.get("accept-language"),
    enabled,
  });
}
