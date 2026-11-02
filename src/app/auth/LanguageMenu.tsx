"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { LOCALE_NAMES, t, type Locale } from "../../i18n";
import { useLocale, useLocaleSettings } from "../../i18n/client";
import { Icon, Sheet } from "../../ui";

/**
 * Each language's name in the page's own language ("French" on an
 * English page, "Französisch" on a German one), from the platform, so
 * no catalog strings. Left out when the platform has none or it only
 * repeats the language's own name.
 */
function nameInPageLanguage(code: Locale, pageLocale: Locale): string | undefined {
  try {
    const name = new Intl.DisplayNames([pageLocale], { type: "language" }).of(code);
    const own = LOCALE_NAMES[code];
    return name && name.toLocaleLowerCase(pageLocale) !== own.toLocaleLowerCase(code) ? name : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The language list behind "Language" in the "you" menu (PIN-191):
 * every enabled language in its own name (English first), the current
 * one marked. Picking one saves the choice and reloads the page in it.
 * PIN-247: a plain list (own name, the name in the page's language
 * under it, a check on the current one) instead of one pill button per
 * language with the current one filled like a main action.
 * Rendered in a portal so a header's own stacking never clips the sheet.
 */
export function LanguageMenu({ onClose }: { onClose: () => void }) {
  const locale = useLocale();
  const { enabled, setLocale } = useLocaleSettings();
  const choose = (next: Locale) => {
    if (next === locale) {
      onClose();
      return;
    }
    setLocale(next);
  };
  const sheet = (
    <Sheet title={t(locale, "you.languageTitle")} closeLabel={t(locale, "ui.close")} onClose={onClose}>
      <ul className="pn-lang-list">
        {enabled.map((code) => {
          const current = code === locale;
          const gloss = nameInPageLanguage(code, locale);
          return (
            <li key={code}>
              <button
                type="button"
                className="pn-lang-option"
                aria-current={current ? "true" : undefined}
                onClick={() => choose(code)}
              >
                <span className="pn-lang-names">
                  <span className="pn-lang-name" lang={code}>
                    {LOCALE_NAMES[code]}
                  </span>
                  {gloss ? <span className="pn-lang-gloss">{gloss}</span> : null}
                </span>
                <span className="pn-lang-check" aria-hidden="true">
                  {current ? <Icon name="check" size={16} /> : null}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </Sheet>
  );
  return typeof document === "undefined" ? sheet : createPortal(sheet, document.body);
}

/**
 * The footer's language switch (PIN-247): a globe and the current
 * language in its own name, opening the same list. Nothing when only
 * one language is on, so single-language deploys look as before.
 */
export function LanguageLink() {
  const locale = useLocale();
  const { enabled } = useLocaleSettings();
  const [open, setOpen] = useState(false);
  if (enabled.length < 2) return null;
  return (
    <>
      <button type="button" className="pn-foot-lang" aria-haspopup="dialog" onClick={() => setOpen(true)}>
        <Icon name="globe" size={18} />
        <span className="pn-sr">{t(locale, "you.language")}: </span>
        <span lang={locale}>{LOCALE_NAMES[locale]}</span>
      </button>
      {open ? <LanguageMenu onClose={() => setOpen(false)} /> : null}
    </>
  );
}
