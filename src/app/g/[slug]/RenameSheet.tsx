"use client";

import { useId, useState, type FormEvent } from "react";
import { normalizeElementLabel } from "../../../domain/element-label";
import { t, tf } from "../../../i18n";
import { useLocale } from "../../../i18n/client";
import { Button, Sheet, TextField } from "../../../ui";
import styles from "./board.module.css";

/**
 * Rename sheet (PIN-157): one field prefilled with the thing's
 * current name, Save / Cancel, Enter saves. The cap is
 * Policy.elementLabelMaxChars in code points, checked with the same
 * rule the server uses (normalizeElementLabel). The field has no
 * native maxlength (it counts UTF-16 units, so emoji would stop at
 * half the cap): the count shows, and an over-long or refused name
 * disables Save and says why. `error` is the failed save's line; the
 * alert line is always mounted so a screen reader hears it arrive.
 */
export function RenameSheet({
  label,
  maxChars,
  busy = false,
  error = "",
  onSave,
  onEdit,
  onClose,
}: {
  /** The thing's current name: the field starts with it. */
  label: string;
  maxChars: number;
  busy?: boolean;
  error?: string;
  onSave: (label: string) => void;
  /** The field changed: the board can drop an error line that was about the old text. */
  onEdit?: () => void;
  onClose: () => void;
}) {
  const locale = useLocale();
  const formId = useId();
  const fieldId = `${formId}-name`;
  const [draft, setDraft] = useState(label);
  const check = normalizeElementLabel(draft, maxChars);
  // An empty field only disables Save; too long or refused characters say why.
  const hint = !check.ok && check.reason !== "empty" ? tf(locale, "board.renameInvalid", { max: maxChars }) : "";

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !check.ok) return;
    onSave(check.label);
  }

  return (
    <Sheet
      title={t(locale, "board.renameTitle")}
      onClose={onClose}
      initialFocusId={fieldId}
      footer={
        <>
          <Button variant="primary" size="lg" block type="submit" form={formId} disabled={busy || !check.ok}>
            {t(locale, "board.renameSave")}
          </Button>
          <Button variant="quiet" size="lg" block onClick={onClose}>
            {t(locale, "board.renameCancel")}
          </Button>
        </>
      }
    >
      <form id={formId} className={styles.renameForm} onSubmit={onSubmit}>
        <TextField
          id={fieldId}
          label={t(locale, "board.renameField")}
          value={draft}
          softMaxLength={maxChars}
          enterKeyHint="done"
          required
          onChange={(value) => {
            setDraft(value);
            onEdit?.();
          }}
        />
        <p className={styles.renameError} role="alert">
          {error || hint}
        </p>
      </form>
    </Sheet>
  );
}
