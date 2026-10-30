"use client";

import { useEffect, useId, useState, type FormEvent } from "react";
import { defaultJoinName } from "../../../domain/auth-ui";
import { t } from "../../../i18n";
import { Button, Icon, Sheet, TextField } from "../../../ui";
import styles from "./board.module.css";

export interface JoinedParticipant {
  id: string;
  displayName: string;
}

/**
 * Join (or rename) sheet (PIN-98). Opens when someone who has not
 * joined taps Add, Make, a thing or Remix — the page continues
 * that action after joining — and from "Edit" once joined. The
 * client contract is unchanged: POST participants with
 * { displayName, reclaimPin? } (PIN-87 profile-name prefill; the
 * reclaim PIN path is hardened server-side, PIN-90).
 */
export function JoinSheet({
  slug,
  me,
  profileName,
  onJoined,
  onClose,
}: {
  slug: string;
  me: JoinedParticipant | null;
  profileName: string | null;
  onJoined: (participant: JoinedParticipant) => void;
  onClose: () => void;
}) {
  const formId = useId();
  const nameId = `${formId}-name`;
  const [displayName, setDisplayName] = useState(me?.displayName ?? "");
  const [nameTouched, setNameTouched] = useState(false);
  const [reclaimPin, setReclaimPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // PIN-87: signed in but not joined yet -> prefill the profile
  // name (auth hydrates async, so this runs when it lands).
  // Never overwrites typing: once touched, the field is theirs.
  useEffect(() => {
    if (me || nameTouched) return;
    const prefill = defaultJoinName(profileName);
    if (prefill) setDisplayName(prefill);
  }, [me, nameTouched, profileName]);

  // The name is the one thing this sheet asks for: put the caret there.
  useEffect(() => {
    document.getElementById(nameId)?.focus({ preventScroll: true });
  }, [nameId]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/boards/${encodeURIComponent(slug)}/participants`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName, reclaimPin: reclaimPin || undefined }),
      });
      const data = (await response.json()) as {
        participant?: JoinedParticipant;
        error?: string;
      };
      if (!response.ok || !data.participant) throw new Error(data.error || t("en", "join.error"));
      setReclaimPin("");
      onJoined(data.participant);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("en", "join.error"));
    } finally {
      setBusy(false);
    }
  }

  const submitLabel = busy
    ? me
      ? t("en", "join.savingName")
      : t("en", "join.saving")
    : me
      ? t("en", "join.update")
      : t("en", "join.submit");

  return (
    <Sheet
      title={me ? t("en", "join.editTitle") : t("en", "join.title")}
      onClose={onClose}
      footer={
        <Button
          variant="primary"
          size="lg"
          block
          type="submit"
          form={formId}
          disabled={busy || !displayName.trim()}
        >
          {submitLabel}
        </Button>
      }
    >
      <form id={formId} className="pn-sheet-body" onSubmit={onSubmit}>
        {!me ? <p className={styles.joinLead}>{t("en", "board.joinFirst")}</p> : null}
        <TextField
          id={nameId}
          label={t("en", "join.name")}
          value={displayName}
          placeholder={t("en", "join.namePlaceholder")}
          autoComplete="nickname"
          enterKeyHint="go"
          required
          onChange={(value) => {
            setNameTouched(true);
            setDisplayName(value);
          }}
        />
        <details className={styles.disclosure}>
          <summary>
            <Icon name="lock" size={18} />
            {t("en", "join.pinSummary")}
          </summary>
          <TextField
            label={t("en", "join.pin")}
            value={reclaimPin}
            placeholder="1234"
            inputMode="numeric"
            autoComplete="one-time-code"
            enterKeyHint="go"
            help={t("en", "join.pinHelp")}
            onChange={(value) => setReclaimPin(value.replace(/\D/g, "").slice(0, 4))}
          />
        </details>
        {error ? (
          <p className={styles.joinError} role="alert">
            {error}
          </p>
        ) : null}
      </form>
    </Sheet>
  );
}
