import en from "./messages/en.json";
import fr from "./messages/fr.json";

/** FR9 seam: EN is complete; FR ships empty and falls back to EN. */
export type Locale = "en" | "fr";
export type MessageKey = keyof typeof en;

const catalogs: Record<Locale, Partial<Record<MessageKey, string>>> = { en, fr };

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

/** Pick the `.one` / `.other` form of a count message, then fill `{n}`. */
export function tCount(
  locale: Locale,
  baseKey: string,
  n: number,
): string {
  const key = `${baseKey}.${n === 1 ? "one" : "other"}` as MessageKey;
  return tf(locale, key, { n });
}
