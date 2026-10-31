"use client";

import { createPortal } from "react-dom";
import { LOCALE_NAMES, t, type Locale } from "../../i18n";
import { useLocale, useLocaleSettings } from "../../i18n/client";
import { Button, Sheet } from "../../ui";

/**
 * The language list behind "Language" in the "you" menu (PIN-191):
 * every enabled language in its own name (English first), the current
 * one marked. Picking one saves the choice and reloads the page in it.
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
      <ul style={{ display: "grid", gap: "var(--space-2)", listStyle: "none", margin: 0, padding: 0 }}>
        {enabled.map((code) => {
          const current = code === locale;
          return (
            <li key={code}>
              <Button
                block
                size="lg"
                variant={current ? "primary" : "secondary"}
                icon={current ? "check" : undefined}
                aria-current={current ? "true" : undefined}
                onClick={() => choose(code)}
              >
                <span lang={code}>{LOCALE_NAMES[code]}</span>
              </Button>
            </li>
          );
        })}
      </ul>
    </Sheet>
  );
  return typeof document === "undefined" ? sheet : createPortal(sheet, document.body);
}
