/**
 * UI languages and how a request picks one (PIN-190, docs/18-i18n.md).
 * Pure: no env, no Next APIs, safe on server and client.
 */

/** Every language with a catalog in ./messages. English is the source and the fallback. */
export const LOCALES = ["en", "fr", "es", "pt-BR", "de", "it", "id"] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";

/** Remembers a language the user picked by hand (switcher, PIN-191). */
export const LOCALE_COOKIE = "pinneds_locale";

/** Each language in its own words, for the switcher. */
export const LOCALE_NAMES: Record<Locale, string> = {
  en: "English",
  fr: "Français",
  es: "Español",
  "pt-BR": "Português (Brasil)",
  de: "Deutsch",
  it: "Italiano",
  id: "Bahasa Indonesia",
};

/** Old or alternate primary subtags that mean one of ours ("in" is Indonesian on older Android). */
const BASE_ALIASES: Readonly<Record<string, string>> = { in: "id" };

const LANGUAGE_TAG = /^(?:[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*|\*)$/;

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

function baseOf(tag: string): string {
  const base = tag.toLowerCase().split("-")[0] ?? "";
  return BASE_ALIASES[base] ?? base;
}

/**
 * UI_LOCALES: a comma list of codes (case-insensitive). Unknown codes
 * are dropped and English is always on. Result follows LOCALES order,
 * so English comes first.
 */
export function parseLocaleList(raw: string | undefined): Locale[] {
  const wanted = new Set(
    (raw ?? "")
      .split(",")
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean),
  );
  return LOCALES.filter((locale) => locale === DEFAULT_LOCALE || wanted.has(locale.toLowerCase()));
}

/**
 * Accept-Language → tags, best first. Entries with q=0 ("not wanted"),
 * a bad q or a malformed tag are skipped; ties keep header order.
 */
export function parseAcceptLanguage(header: string | null | undefined): string[] {
  if (!header) return [];
  const entries: { tag: string; q: number; index: number }[] = [];
  header.split(",").forEach((part, index) => {
    const [rawTag = "", ...params] = part.split(";");
    const tag = rawTag.trim();
    if (!LANGUAGE_TAG.test(tag)) return;
    let q = 1;
    for (const param of params) {
      const match = /^\s*q\s*=\s*(.*?)\s*$/i.exec(param);
      if (match) q = /^[0-9.]+$/.test(match[1] ?? "") ? Number(match[1]) : Number.NaN;
    }
    if (!Number.isFinite(q) || q <= 0 || q > 1) return;
    entries.push({ tag, q, index });
  });
  return entries.sort((a, b) => b.q - a.q || a.index - b.index).map((entry) => entry.tag);
}

/** One tag against the enabled list: exact match first, then same base language (pt-PT → pt-BR). */
export function matchLocale(tag: string, enabled: readonly Locale[]): Locale | null {
  const lower = tag.toLowerCase();
  const exact = enabled.find((locale) => locale.toLowerCase() === lower);
  if (exact) return exact;
  const base = baseOf(tag);
  return enabled.find((locale) => baseOf(locale) === base) ?? null;
}

/**
 * The request's language: the saved choice if that language is on,
 * else the best Accept-Language match, else English.
 */
export function negotiateLocale(input: {
  cookie?: string | null;
  acceptLanguage?: string | null;
  enabled: readonly Locale[];
}): Locale {
  const { cookie, enabled } = input;
  if (isLocale(cookie) && enabled.includes(cookie)) return cookie;
  for (const tag of parseAcceptLanguage(input.acceptLanguage)) {
    const match = matchLocale(tag, enabled);
    if (match) return match;
  }
  return DEFAULT_LOCALE;
}

/**
 * The language when no server or provider is around (global-error,
 * PIN-212, where the root layout itself failed): the saved choice in
 * the cookie jar, else the page's own `lang` (the server already
 * negotiated it), else English. Every language counts as on, because
 * the cookie is only ever written for an enabled one and `lang`
 * came from the server's enabled list.
 */
export function localeFromDocument(cookieJar: string, htmlLang: string): Locale {
  const saved = cookieJar
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${LOCALE_COOKIE}=`))
    ?.slice(LOCALE_COOKIE.length + 1);
  return negotiateLocale({ cookie: saved, acceptLanguage: htmlLang, enabled: LOCALES });
}
