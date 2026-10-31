"use client";

import type { ChangeEvent } from "react";
import { t } from "../../../i18n";
import { useLocale } from "../../../i18n/client";
import { Icon } from "../../../ui";

/**
 * The add-photo pick step (PIN-118): two explicit actions instead
 * of one bare file input, whose OS chooser may hide the camera
 * (desktop, some in-app browsers). "Take photo" carries
 * capture="environment" so phones open the rear camera; "Choose
 * photo" is a plain input for the library. Capture must never go
 * on the only input — that would force the camera and hide the
 * library. The library input accepts several files in one pick
 * (the batch queue caps them at Policy.photosPerBatch); the camera
 * stays one shot at a time.
 */
export function PhotoPick({ onFiles }: { onFiles: (files: File[]) => void }) {
  const locale = useLocale();
  const onChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files ?? [])];
    event.target.value = "";
    if (files.length > 0) onFiles(files);
  };
  return (
    <div className="pn-add-pick">
      <span className="pn-add-pick-icon" aria-hidden="true">
        <Icon name="camera" size={28} />
      </span>
      <span className="pn-add-pick-title">{t(locale, "add.pick")}</span>
      <span className="pn-add-pick-help">{t(locale, "add.pickHelp")}</span>
      <span className="pn-add-pick-actions">
        <label className="pn-btn pn-btn-primary pn-add-pick-action">
          <Icon name="camera" size={20} />
          {t(locale, "add.takePhoto")}
          <input type="file" accept="image/*" capture="environment" className="pn-sr" onChange={onChange} />
        </label>
        <label className="pn-btn pn-btn-secondary pn-add-pick-action">
          <Icon name="scene" size={20} />
          {t(locale, "add.choosePhoto")}
          <input type="file" accept="image/*" multiple className="pn-sr" onChange={onChange} />
        </label>
      </span>
    </div>
  );
}
