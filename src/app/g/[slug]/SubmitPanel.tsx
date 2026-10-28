"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { t } from "../../../i18n";

interface OwnSubmission {
  id: string;
  status: string;
  submittedAt: number;
  hasPhoto: boolean;
  judged?: boolean;
  privateJudgement?: string | null;
  hasCutout?: boolean;
}

const MAX_BYTES = 10 * 1024 * 1024;

export function SubmitPanel({
  slug,
  canSubmit,
  onHasPhoto,
}: {
  slug: string;
  canSubmit: boolean;
  onHasPhoto?: (hasPhoto: boolean) => void;
}) {
  const [submission, setSubmission] = useState<OwnSubmission | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [localPreview, setLocalPreview] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [previewBust, setPreviewBust] = useState(0);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [cutBusy, setCutBusy] = useState(false);
  const [cutNotice, setCutNotice] = useState("");

  async function cutoutAction(payload: Record<string, unknown>) {
    if (cutBusy) return;
    setCutBusy(true);
    setCutNotice("");
    setError("");
    try {
      const response = await fetch(`/api/games/${encodeURIComponent(slug)}/submissions/cutout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await response.json()) as { submission?: OwnSubmission; outcome?: string; error?: string };
      if (!response.ok || !data.submission) throw new Error(data.error || t("en", "submit.error"));
      setSubmission(data.submission);
      setPreviewBust((value) => value + 1);
      setCutNotice(data.outcome === "whole" ? t("en", "cutout.wholeDone") : t("en", "cutout.done"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("en", "submit.error"));
    } finally {
      setCutBusy(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(`/api/games/${encodeURIComponent(slug)}/submissions`);
        if (response.ok) {
          const data = (await response.json()) as { submission: OwnSubmission | null };
          if (!cancelled) {
            setSubmission(data.submission);
            onHasPhoto?.(Boolean(data.submission?.hasPhoto));
          }
        }
      } catch {
        // The form below still works; a failed prefetch only hides state.
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  if (!canSubmit) return null;

  function pickFile(next: File | null, clearNotice = true) {
    if (localPreview) URL.revokeObjectURL(localPreview);
    setFile(next);
    if (clearNotice) setNotice("");
    setLocalPreview(next ? URL.createObjectURL(next) : "");
    setError(next && next.size > MAX_BYTES ? t("en", "submit.tooLarge") : "");
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setError("");
    setNotice("");
    if (!file) {
      setError(t("en", "submit.error"));
      return;
    }
    if (file.size > MAX_BYTES) {
      setError(t("en", "submit.tooLarge"));
      return;
    }
    setBusy(true);
    try {
      const form = new FormData();
      form.set("photo", file);
      const response = await fetch(`/api/games/${encodeURIComponent(slug)}/submissions`, {
        method: "POST",
        body: form,
      });
      const data = (await response.json()) as {
        submission?: OwnSubmission;
        outcome?: "created" | "replaced";
        error?: string;
      };
      if (!response.ok || !data.submission) {
        throw new Error(data.error || t("en", "submit.error"));
      }
      setSubmission(data.submission);
      onHasPhoto?.(true);
      pickFile(null, false);
      setNotice(data.outcome === "replaced" ? t("en", "submit.replaced") : t("en", "submit.in"));
      setPreviewBust((value) => value + 1);
      if (fileRef.current) fileRef.current.value = "";
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("en", "submit.error"));
    } finally {
      setBusy(false);
    }
  }

  const previewSrc = localPreview
    ? localPreview
    : loaded && submission?.hasPhoto
      ? `/api/games/${encodeURIComponent(slug)}/submissions/image?v=${previewBust}`
      : "";

  return (
    <section className="card">
      <h2>{t("en", "submit.title")}</h2>
      <p className="notice">{t("en", "submit.safety")}</p>

      {submission?.privateJudgement ? (
        <aside className="host-verdict" aria-live="polite">
          <p className="eyebrow">{t("en", "submit.hostSays")}</p>
          <p className="challenge">{submission.privateJudgement}</p>
          <p className="notice">{t("en", "submit.judgedWait")}</p>
        </aside>
      ) : submission?.hasPhoto ? (
        <p className="notice" role="status">{t("en", "submit.judging")}</p>
      ) : null}

      {previewSrc ? (
        <figure className="entry-preview">
          {/* Owner-only derivative preview; plain img keeps the cookie flow simple. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={previewSrc}
            alt={t("en", "submit.current")}
            onClick={(event) => {
              if (!submission?.hasPhoto || localPreview) return;
              const rect = event.currentTarget.getBoundingClientRect();
              const x = (event.clientX - rect.left) / rect.width;
              const y = (event.clientY - rect.top) / rect.height;
              void cutoutAction({ action: "point", point: { x, y } });
            }}
          />
        </figure>
      ) : loaded ? (
        <p>{t("en", "submit.none")}</p>
      ) : null}

      {loaded && submission?.hasPhoto ? (
        <div className="cutout-box">
          <p className="eyebrow">{t("en", "cutout.title")}</p>
          {submission.hasCutout ? (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img className="cutout-preview" src={`/api/games/${encodeURIComponent(slug)}/submissions/image?kind=cutout&v=${previewBust}`} alt={t("en", "cutout.title")} />
              <div className="actions">
                <button type="button" className="btn btn-primary" disabled={cutBusy} onClick={() => void cutoutAction({ action: "accept" })}>{cutBusy ? t("en", "cutout.working") : t("en", "cutout.accept")}</button>
                <button type="button" className="btn" disabled={cutBusy} onClick={() => void cutoutAction({ action: "whole" })}>{t("en", "cutout.whole")}</button>
              </div>
              <p className="notice">{t("en", "cutout.tap")}</p>
            </>
          ) : <p className="notice">{t("en", "cutout.none")}</p>}
          {cutNotice ? <p className="notice" role="status">{cutNotice}</p> : null}
        </div>
      ) : null}

      <form onSubmit={onSubmit}>
        <label className="btn photo-pick" aria-disabled={busy}>
          {t("en", "submit.choose")}
        <input
          ref={fileRef}
          className="visually-hidden"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          disabled={busy}
          onChange={(event) => pickFile(event.target.files?.[0] ?? null)}
        />
        </label>
        {notice ? <p className="notice" role="status">{notice}</p> : null}
        {error ? <p className="error" role="alert">{error}</p> : null}
        <button className="btn btn-primary" type="submit" disabled={busy || !file}>
          {busy
            ? t("en", "submit.judging")
            : submission
              ? t("en", "submit.replace")
              : t("en", "submit.send")}
        </button>
      </form>
    </section>
  );
}
