import en from "./messages/en.json";
import fr from "./messages/fr.json";

/** FR9 seam: EN is complete; FR ships empty and falls back to EN. */
export type Locale = "en" | "fr";
export type MessageKey = keyof typeof en;

const catalogs: Record<Locale, Partial<Record<MessageKey, string>>> = { en, fr };

export function t(locale: Locale, key: MessageKey): string {
  return catalogs[locale][key] ?? en[key];
}
