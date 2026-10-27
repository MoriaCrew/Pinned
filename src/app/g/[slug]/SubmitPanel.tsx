"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { t } from "../../../i18n";

interface OwnSubmission {
  id: string;
  status: string;
  submittedAt: number;
  hasPhoto: boolean;
}

const MAX_BYTES = 10 * 1024 * 1024;

export function SubmitPanel({ slug, canSubmit }: { slug: string; canSubmit: boolean }) {
  const [submission, setSubmission] = useState<OwnSubmission | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [localPreview, setLocalPreview] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [previewBust, setPreviewBust] = useState(0);
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(`/api/games/${encodeURIComponent(slug)}/submissions`);
        if (response.ok) {
          const data = (await response.json()) as { submission: OwnSubmission | null };
          if (!cancelled) setSubmission(data.submission);
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

  function pickFile(next: File | null) {
    if (localPreview) URL.revokeObjectURL(localPreview);
    setFile(next);
    setNotice("");
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
      setNotice(data.outcome === "replaced" ? t("en", "submit.replaced") : t("en", "submit.in"));
      setPreviewBust((value) => value + 1);
      pickFile(null);
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

      {previewSrc ? (
        <figure className="entry-preview">
          {/* Owner-only derivative preview; plain img keeps the cookie flow simple. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={previewSrc} alt={t("en", "submit.current")} />
        </figure>
      ) : loaded ? (
        <p>{t("en", "submit.none")}</p>
      ) : null}

      <form onSubmit={onSubmit}>
        <label className="btn photo-pick" htmlFor="photo-file">
          {t("en", "submit.choose")}
        </label>
        <input
          id="photo-file"
          ref={fileRef}
          className="visually-hidden"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          onChange={(event) => pickFile(event.target.files?.[0] ?? null)}
        />
        {notice ? <p className="notice" role="status">{notice}</p> : null}
        {error ? <p className="error" role="alert">{error}</p> : null}
        <button className="btn btn-primary" type="submit" disabled={busy || !file}>
          {busy
            ? t("en", "submit.sending")
            : submission
              ? t("en", "submit.replace")
              : t("en", "submit.send")}
        </button>
      </form>
    </section>
  );
}
