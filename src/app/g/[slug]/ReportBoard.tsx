"use client";

import { useId, useRef, useState, type FormEvent } from "react";
import { REPORT_REASONS, type ReportReason } from "../../../domain/board-report";
import { t, tf, type MessageKey } from "../../../i18n";
import { useLocale } from "../../../i18n/client";
import { Button, Chip, Sheet, TextField, cx } from "../../../ui";
import styles from "./board.module.css";

/**
 * Report (PIN-271, ADR-004): the quiet link at the foot of every board
 * page, for visitors too, now opens a sheet instead of a mail. What
 * (this board, a pin, a scene), why (one reason), a message, an optional
 * email, then Confirm; `POST /api/boards/<slug>/report` hides the
 * reported thing at once and answers with the board's opaque reference,
 * which the receipt shows. The legal address stays as plain text with
 * the reference for follow-up. The capability slug never appears in the
 * sheet, the request body or the receipt (the URL carries it already).
 */

export interface ReportTargets {
  /** Visible pins, by element id and label. */
  pins: { id: string; label: string }[];
  /** Ready scenes, newest first, numbered for people (no scene has a name). */
  scenes: { id: string; index: number }[];
}

export type ReportScopeKey = "board" | `element:${string}` | `scene:${string}`;

export interface ReportResult {
  reference: string;
  held: boolean;
}

const REASON_KEYS: Record<ReportReason, MessageKey> = {
  likeness: "board.reportReason.likeness",
  inappropriate: "board.reportReason.inappropriate",
  illegal: "board.reportReason.illegal",
  ownership: "board.reportReason.ownership",
  other: "board.reportReason.other",
};

export function canSendReport(reason: ReportReason | null, message: string): boolean {
  if (!reason) return false;
  return reason !== "other" || message.trim().length > 0;
}

/** Scope key → request fields. */
export function scopeFields(key: ReportScopeKey): { scope: "board" } | { scope: "element" | "scene"; targetId: string } {
  if (key === "board") return { scope: "board" };
  const [kind, id] = key.split(":", 2) as ["element" | "scene", string];
  return { scope: kind, targetId: id };
}

/** The form, stateless: the sheet owns the state, tests render states. */
export function ReportForm({
  targets,
  scopeKey,
  reason,
  message,
  email,
  messageMaxChars,
  sending,
  error,
  onScope,
  onReason,
  onMessage,
  onEmail,
  messageId,
}: {
  targets: ReportTargets;
  scopeKey: ReportScopeKey;
  reason: ReportReason | null;
  message: string;
  email: string;
  messageMaxChars: number;
  sending: boolean;
  error: string | null;
  onScope: (key: ReportScopeKey) => void;
  onReason: (reason: ReportReason) => void;
  onMessage: (value: string) => void;
  onEmail: (value: string) => void;
  messageId: string;
}) {
  const locale = useLocale();
  const scopeLabelId = `${messageId}-scope`;
  const reasonLabelId = `${messageId}-reason`;
  return (
    <div className={styles.reportForm}>
      <p className={styles.reportGroupLabel} id={scopeLabelId}>
        {t(locale, "board.reportScopeLabel")}
      </p>
      <div className={cx("pn-chip-row", styles.reportChips)} role="group" aria-labelledby={scopeLabelId}>
        <Chip selected={scopeKey === "board"} onClick={() => onScope("board")} disabled={sending}>
          {t(locale, "board.reportScopeBoard")}
        </Chip>
        {targets.pins.map((pin) => (
          <Chip key={pin.id} selected={scopeKey === `element:${pin.id}`} onClick={() => onScope(`element:${pin.id}`)} disabled={sending}>
            {pin.label}
          </Chip>
        ))}
        {targets.scenes.map((scene) => (
          <Chip key={scene.id} selected={scopeKey === `scene:${scene.id}`} onClick={() => onScope(`scene:${scene.id}`)} disabled={sending}>
            {tf(locale, "board.reportScopeScene", { n: scene.index })}
          </Chip>
        ))}
      </div>
      <p className={styles.reportGroupLabel} id={reasonLabelId}>
        {t(locale, "board.reportReasonLabel")}
      </p>
      <div className={cx("pn-chip-row", styles.reportChips)} role="group" aria-labelledby={reasonLabelId}>
        {REPORT_REASONS.map((value) => (
          <Chip key={value} selected={reason === value} onClick={() => onReason(value)} disabled={sending}>
            {t(locale, REASON_KEYS[value])}
          </Chip>
        ))}
      </div>
      <TextField
        id={messageId}
        label={t(locale, "board.reportMessage")}
        value={message}
        onChange={onMessage}
        multiline
        rows={3}
        softMaxLength={messageMaxChars}
        required={reason === "other"}
        help={t(locale, "board.reportMessageHelp")}
      />
      <TextField
        id={`${messageId}-email`}
        label={t(locale, "board.reportEmail")}
        value={email}
        onChange={onEmail}
        autoComplete="email"
        help={t(locale, "board.reportEmailHelp")}
      />
      {error ? (
        <p className={styles.reportError} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** The receipt: what happened and the reference to quote. */
export function ReportReceipt({ result, email }: { result: ReportResult; email?: string | null }) {
  const locale = useLocale();
  return (
    <div className={styles.reportReceipt} role="status">
      <p>{tf(locale, result.held ? "board.reportHeld" : "board.reportReceived", { ref: result.reference })}</p>
      {email ? (
        <p className={styles.reportManual}>
          {t(locale, "board.reportFollowUp")} <span className={styles.reportMono}>{email}</span>
        </p>
      ) : null}
    </div>
  );
}

export function ReportBoard({
  slug,
  email,
  reportRef,
  targets,
  messageMaxChars,
  onReported,
}: {
  slug: string;
  email?: string | null;
  reportRef?: string | null;
  targets: ReportTargets;
  messageMaxChars: number;
  onReported?: (result: ReportResult) => void;
}) {
  const locale = useLocale();
  const messageId = useId();
  const [open, setOpen] = useState(false);
  const [scopeKey, setScopeKey] = useState<ReportScopeKey>("board");
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [message, setMessage] = useState("");
  const [emailValue, setEmailValue] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ReportResult | null>(null);
  // One request at a time, whatever the render state says in between.
  const inFlight = useRef(false);
  if (!reportRef) return null;

  const close = () => {
    // Escape, the scrim and the X all land here: while the answer is
    // on its way the sheet stays, so the receipt is seen and the form
    // cannot be sent twice.
    if (inFlight.current) return;
    setOpen(false);
    setError(null);
    if (result) {
      setResult(null);
      setScopeKey("board");
      setReason(null);
      setMessage("");
      setEmailValue("");
    }
  };

  const send = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!canSendReport(reason, message) || inFlight.current || !reason) return;
    inFlight.current = true;
    setSending(true);
    setError(null);
    try {
      const body = {
        ...scopeFields(scopeKey),
        reason,
        ...(message.trim() ? { message: message.trim() } : {}),
        ...(emailValue.trim() ? { reporterEmail: emailValue.trim() } : {}),
      };
      const response = await fetch(`/api/boards/${encodeURIComponent(slug)}/report`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await response.json().catch(() => null)) as { reference?: string; held?: boolean; error?: string } | null;
      if (!response.ok || !data?.reference) {
        setError(data?.error || t(locale, "request.reportFailed"));
        return;
      }
      const outcome = { reference: data.reference, held: data.held === true };
      setResult(outcome);
      onReported?.(outcome);
    } catch {
      setError(t(locale, "request.reportFailed"));
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  };

  const footer = result ? (
    <Button variant="primary" size="lg" onClick={close}>
      {t(locale, "board.reportDone")}
    </Button>
  ) : (
    <>
      <Button variant="quiet" onClick={close} disabled={sending}>
        {t(locale, "board.reportCancel")}
      </Button>
      <Button variant="primary" size="lg" onClick={() => void send()} disabled={!canSendReport(reason, message) || sending}>
        {t(locale, sending ? "board.reportSending" : "board.reportSend")}
      </Button>
    </>
  );

  return (
    <>
      <footer className={styles.reportFoot}>
        <button type="button" className={styles.reportLink} onClick={() => setOpen(true)} aria-haspopup="dialog">
          {t(locale, "board.report")}
        </button>
        <dl className={styles.reportFacts}>
          {email ? (
            <div>
              <dt>{t(locale, "board.reportAddress")}</dt>
              <dd>{email}</dd>
            </div>
          ) : null}
          <div>
            <dt>{t(locale, "board.reportRef")}</dt>
            <dd>{reportRef}</dd>
          </div>
        </dl>
      </footer>
      {open ? (
        <Sheet
          title={t(locale, "board.reportTitle")}
          onClose={close}
          closeLabel={t(locale, "board.reportClose")}
          footer={footer}
          className="pn-report-sheet"
          keyboardAware
        >
          {result ? (
            <ReportReceipt result={result} email={email} />
          ) : (
            <form onSubmit={(event) => void send(event)}>
              <ReportForm
                targets={targets}
                scopeKey={scopeKey}
                reason={reason}
                message={message}
                email={emailValue}
                messageMaxChars={messageMaxChars}
                sending={sending}
                error={error}
                onScope={setScopeKey}
                onReason={setReason}
                onMessage={setMessage}
                onEmail={setEmailValue}
                messageId={messageId}
              />
            </form>
          )}
        </Sheet>
      ) : null}
    </>
  );
}
