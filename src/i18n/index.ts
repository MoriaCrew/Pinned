import en from "./messages/en.json";
import fr from "./messages/fr.json";
import es from "./messages/es.json";
import ptBR from "./messages/pt-BR.json";
import de from "./messages/de.json";
import it from "./messages/it.json";
import id from "./messages/id.json";
import { DEFAULT_LOCALE, type Locale } from "./locales";

export {
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  LOCALE_NAMES,
  LOCALES,
  isLocale,
  type Locale,
} from "./locales";

/** EN is complete; every other catalog may miss keys and falls back to EN (PIN-23). */
export type MessageKey = keyof typeof en;

type Catalog = Partial<Record<MessageKey, string>>;

const catalogs: Record<Locale, Catalog> = { en, fr, es, "pt-BR": ptBR, de, it, id };

export function t(locale: Locale, key: MessageKey): string {
  return catalogs[locale][key] ?? en[key];
}

/**
 * Message with `{name}` placeholders (PIN-97), e.g. "{n} of {max}
 * picked". Unknown placeholders are left as written so a missing
 * value is visible instead of silently blank.
 */
export function tf(
  locale: Locale,
  key: MessageKey,
  values: Record<string, string | number>,
): string {
  return t(locale, key).replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match,
  );
}

const pluralRules = new Map<Locale, Intl.PluralRules>();

function pluralRule(locale: Locale): Intl.PluralRules {
  let rule = pluralRules.get(locale);
  if (!rule) {
    rule = new Intl.PluralRules(locale);
    pluralRules.set(locale, rule);
  }
  return rule;
}

/**
 * Pick the `.one` / `.other` form of a count message, then fill `{n}`.
 * The form follows the language's own rule (PIN-190: French says
 * "0 création"); every other CLDR category uses `.other`. A language
 * that has not translated this message yet uses English's rule, so
 * the English fallback stays grammatical.
 */
export function tCount(
  locale: Locale,
  baseKey: string,
  n: number,
): string {
  const translated = catalogs[locale][`${baseKey}.other` as MessageKey] !== undefined;
  const ruleLocale = translated ? locale : DEFAULT_LOCALE;
  const form = pluralRule(ruleLocale).select(n) === "one" ? "one" : "other";
  return tf(ruleLocale, `${baseKey}.${form}` as MessageKey, { n });
}

/**
 * Intl output uses U+202F (narrow no-break space) in French numbers
 * and English times; our self-hosted fonts lack it, so swap in the
 * regular no-break space (same no-wrap behaviour).
 */
function fontSafe(text: string): string {
  return text.replace(/ /g, " ");
}

/** Money from minor units (cents) for a 2-decimal currency, e.g. 499 EUR → "€4.99" / "4,99 €". */
export function formatMoney(locale: Locale, cents: number, currency: string): string {
  return fontSafe(new Intl.NumberFormat(locale, { style: "currency", currency }).format(cents / 100));
}

export function formatDate(
  locale: Locale,
  epochMs: number,
  options: Intl.DateTimeFormatOptions,
): string {
  return fontSafe(new Intl.DateTimeFormat(locale, options).format(new Date(epochMs)));
}

/** "A, B and C" in the language's own words and punctuation. */
export function formatList(locale: Locale, items: readonly string[]): string {
  return new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(items);
}
