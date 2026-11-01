"use client";

import { startChoice, type SkinSuggestion } from "../../domain/skin-suggest";
import { SKINS, type SkinId } from "../../domain/skins";
import { t, tf, type MessageKey } from "../../i18n";
import { useLocale } from "../../i18n/client";
import { Button, Icon, Sheet, SkinPicker, skinName } from "../../ui";

/** Synthetic cut-outs the mini boards in the look picker wear (public/start/README.md). */
const SAMPLE = ["/start/cutout-rubber-duck.webp", "/start/cutout-red-sneakers.webp", "/start/cutout-straw-hat.webp"];

/**
 * Step 2 of the start flow (PIN-101): the look sheet. The skin the
 * title suggests starts selected; the one button names the look it
 * will use, in the visitor's language (PIN-232).
 */
export function StartLookSheet({
  suggestion,
  skin,
  busy,
  error,
  onPick,
  onCreate,
  onClose,
}: {
  suggestion: SkinSuggestion;
  skin: SkinId;
  busy: boolean;
  error: string;
  onPick: (skin: SkinId) => void;
  onCreate: () => void;
  /** Stable identity: Sheet re-focuses itself whenever onClose changes. */
  onClose: () => void;
}) {
  const locale = useLocale();
  const choice = startChoice(skin, suggestion.skin);
  const reason = suggestion.reason;
  const [fitsBefore, fitsAfter] = t(locale, reason ? "create.fits" : "create.noSuggestion").split("{skin}");
  return (
    <Sheet
      className="pn-start-sheet"
      title={t(locale, "create.lookTitle")}
      closeLabel={t(locale, "create.back")}
      onClose={onClose}
      footer={
        <>
          {error ? (
            <p className="pn-start-error" role="alert">
              <Icon name="info" size={16} />
              {error}
            </p>
          ) : choice.tryOn ? (
            <p className="pn-start-note">{t(locale, "create.plusNote")}</p>
          ) : null}
          <Button variant="primary" size="lg" block disabled={busy} onClick={onCreate}>
            {busy
              ? t(locale, "create.creating")
              : error
                ? t(locale, "create.retry")
                : tf(locale, "create.use", { skin: skinName(skin, locale) })}
          </Button>
          <span className="pn-sr" role="status">
            {busy ? t(locale, "create.creating") : ""}
          </span>
        </>
      }
    >
      <p className="pn-start-spark">
        <Icon name="skin" size={20} />
        <span>
          {reason ? `${t(locale, `create.reason.${reason}` as MessageKey)} ` : null}
          {fitsBefore}
          <b>{skinName(suggestion.skin, locale)}</b>
          {fitsAfter}
        </span>
      </p>
      <div className="pn-start-picker">
        <SkinPicker
          skins={SKINS.map((option) => ({
            id: option.id,
            suggested: reason !== null && option.id === suggestion.skin,
            locked: option.plus,
          }))}
          value={skin}
          onChange={onPick}
          sample={SAMPLE}
          legend={t(locale, "ui.look")}
        />
      </div>
    </Sheet>
  );
}
