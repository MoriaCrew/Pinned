"use client";

import { useState, type FormEvent } from "react";
import { t } from "../../i18n";
import type { HostPersona } from "../../gateway/model-gateway";

type Preset = "express" | "evening" | "24h" | "custom";

interface CreatedGame {
  game: {
    id: string;
    state: string;
    challenge: string;
    persona: HostPersona;
    deadlineAt: number;
    entryCount: number;
  };
  playerUrl: string;
  adminUrl: string;
  inviteText: string;
}

function formatDeadline(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(value);
}

function CopyField({ label, value, rows = 1 }: { label: string; value: string; rows?: number }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="field">
      <label>{label}</label>
      <div className="copy-row">
        <textarea readOnly rows={rows} value={value} onFocus={(event) => event.target.select()} />
        <button type="button" className="btn btn-small" onClick={copy}>
          {copied ? t("en", "create.copied") : t("en", "create.copy")}
        </button>
      </div>
    </div>
  );
}

export function CreateGameForm() {
  const [brief, setBrief] = useState("");
  const [preset, setPreset] = useState<Preset>("express");
  const [customHours, setCustomHours] = useState(6);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<CreatedGame | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/games", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          brief,
          deadlinePreset: preset,
          customHours: preset === "custom" ? customHours : undefined,
          timeZoneOffsetMinutes: new Date().getTimezoneOffset(),
        }),
      });
      const data = (await response.json()) as CreatedGame & { error?: string };
      if (!response.ok) throw new Error(data.error || t("en", "create.error"));
      setResult(data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("en", "create.error"));
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    const { game } = result;
    return (
      <section className="card" aria-live="polite">
        <h2>{t("en", "create.resultTitle")}</h2>
        <p>{t("en", "create.resultIntro")}</p>
        <div className="persona-card">
          <p className="eyebrow">{t("en", "game.host")}</p>
          <h3>{game.persona.name}</h3>
          <p className="challenge">“{game.challenge}”</p>
          <p>{game.persona.judgingStyle}</p>
          <p><strong>{t("en", "create.deadline")}:</strong> {formatDeadline(game.deadlineAt)}</p>
        </div>
        <CopyField label={t("en", "create.playerLink")} value={result.playerUrl} rows={2} />
        <CopyField label={t("en", "create.adminLink")} value={result.adminUrl} rows={3} />
        <CopyField label={t("en", "create.invite")} value={result.inviteText} rows={4} />
        <div className="actions">
          <a className="btn btn-primary" href={result.playerUrl}>{t("en", "create.openPlayer")}</a>
          <button type="button" className="btn" onClick={() => setResult(null)}>
            {t("en", "create.createAnother")}
          </button>
        </div>
      </section>
    );
  }

  return (
    <form className="card" onSubmit={onSubmit}>
      <div className="field">
        <label htmlFor="brief">{t("en", "create.briefLabel")}</label>
        <input
          id="brief"
          value={brief}
          onChange={(event) => setBrief(event.target.value)}
          placeholder={t("en", "create.briefPlaceholder")}
          autoComplete="off"
          required
        />
        <div className="field-meta">
          <span>{t("en", "create.briefHelp")}</span>
          <span aria-live="polite">{[...brief].length}/140</span>
        </div>
      </div>

      <fieldset className="field">
        <legend>{t("en", "create.deadlineLegend")}</legend>
        {([
          ["express", "create.express"],
          ["evening", "create.evening"],
          ["24h", "create.day"],
          ["custom", "create.custom"],
        ] as const).map(([value, label]) => (
          <label className="choice" key={value}>
            <input
              type="radio"
              name="deadline"
              value={value}
              checked={preset === value}
              onChange={() => setPreset(value)}
            />
            <span>{t("en", label)}</span>
          </label>
        ))}
      </fieldset>

      {preset === "custom" ? (
        <div className="field">
          <label htmlFor="custom-hours">{t("en", "create.customLabel")}</label>
          <input
            id="custom-hours"
            type="number"
            min={1}
            max={72}
            step={1}
            value={customHours}
            onChange={(event) => setCustomHours(Number(event.target.value))}
            required
          />
        </div>
      ) : null}

      {error ? <p className="error" role="alert">{error}</p> : null}
      <button className="btn btn-primary" type="submit" disabled={busy || !brief.trim()}>
        {busy ? t("en", "create.working") : t("en", "create.submit")}
      </button>
    </form>
  );
}
