"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { BOARD_THEMES } from "../../domain/board-themes";
import { createBoardPayload } from "../../domain/board-view";
import { t } from "../../i18n";

/**
 * Create flow (PIN-66): title + optional theme. Themes are the
 * PIN-52 preset looks — art and tokens only, no persona. Zero
 * required decisions beyond the title: theme defaults to plain.
 */
export function CreateBoardForm({ titleMaxChars }: { titleMaxChars: number }) {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [themeId, setThemeId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const result = createBoardPayload(title, themeId || null, titleMaxChars);
    if (!result.ok) {
      setError(
        result.reason === "tooLong"
          ? t("en", "create.titleTooLong")
          : t("en", "create.titleRequired"),
      );
      return;
    }
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/boards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(result.payload),
      });
      const data = (await response.json()) as {
        board?: { slug?: string };
        error?: string;
      };
      if (!response.ok || !data.board?.slug) {
        throw new Error(data.error || t("en", "create.error"));
      }
      router.push(`/g/${encodeURIComponent(data.board.slug)}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("en", "create.error"));
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={onSubmit}>
      <div className="field">
        <label htmlFor="board-title">{t("en", "create.nameLabel")}</label>
        <input
          id="board-title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder={t("en", "create.namePlaceholder")}
          maxLength={titleMaxChars}
          autoComplete="off"
          required
        />
      </div>

      <fieldset className="field">
        <legend>{t("en", "create.themeLabel")}</legend>
        <div className="theme-grid">
          <label className="choice-card">
            <input
              type="radio"
              name="theme"
              value=""
              checked={themeId === ""}
              onChange={() => setThemeId("")}
            />
            {t("en", "create.themeNone")}
          </label>
          {BOARD_THEMES.map((theme) => (
            <label key={theme.id} className="choice-card">
              <input
                type="radio"
                name="theme"
                value={theme.id}
                checked={themeId === theme.id}
                onChange={() => setThemeId(theme.id)}
              />
              {theme.motif} {theme.label}
            </label>
          ))}
        </div>
      </fieldset>

      {error ? <p className="error" role="alert">{error}</p> : null}
      <button className="btn btn-primary" type="submit" disabled={busy || !title.trim()}>
        {busy ? t("en", "create.creating") : t("en", "create.submit")}
      </button>
    </form>
  );
}
