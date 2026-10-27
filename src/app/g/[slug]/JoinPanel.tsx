"use client";

import { useState, type FormEvent } from "react";
import { t } from "../../../i18n";
import { SubmitPanel } from "./SubmitPanel";

function Steps({ current }: { current: 1 | 2 | 3 }) {
  const steps = [
    { n: 1, label: t("en", "steps.join") },
    { n: 2, label: t("en", "steps.photo") },
    { n: 3, label: t("en", "steps.done") },
  ] as const;
  return (
    <ol className="progress-steps" aria-label="Progress">
      {steps.map((step) => (
        <li
          key={step.n}
          className={step.n < current ? "pstep done" : step.n === current ? "pstep now" : "pstep"}
          aria-current={step.n === current ? "step" : undefined}
        >
          <span className="pstep-num">{step.n < current ? "✓" : step.n}</span>
          {step.label}
        </li>
      ))}
    </ol>
  );
}

export interface JoinPlayerView {
  id: string;
  displayName: string;
  posterOptIn: boolean;
  hasReclaimPin: boolean;
}

export function JoinPanel({
  slug,
  initialPlayer,
  canJoin,
}: {
  slug: string;
  initialPlayer: JoinPlayerView | null;
  canJoin: boolean;
}) {
  const [player, setPlayer] = useState(initialPlayer);
  const [editing, setEditing] = useState(!initialPlayer);
  const [displayName, setDisplayName] = useState(initialPlayer?.displayName ?? "");
  const [posterOptIn, setPosterOptIn] = useState(initialPlayer?.posterOptIn ?? true);
  const [reclaimPin, setReclaimPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [photoDone, setPhotoDone] = useState(false);

  if (!canJoin && !player) {
    return (
      <section className="card">
        <h2>{t("en", "join.title")}</h2>
        <p>{t("en", "join.closed")}</p>
      </section>
    );
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/games/${encodeURIComponent(slug)}/players`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName,
          posterOptIn,
          reclaimPin: reclaimPin || undefined,
        }),
      });
      const data = (await response.json()) as { player?: JoinPlayerView; error?: string };
      if (!response.ok || !data.player) throw new Error(data.error || t("en", "join.error"));
      setPlayer(data.player);
      setDisplayName(data.player.displayName);
      setPosterOptIn(data.player.posterOptIn);
      setReclaimPin("");
      setEditing(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("en", "join.error"));
    } finally {
      setBusy(false);
    }
  }

  if (player && !editing) {
    return (
      <>
        <Steps current={photoDone ? 3 : 2} />
        <section className="card" aria-live="polite">
          <h2>{t("en", "join.ready")}</h2>
          <p className="fact-chips">
            <span className="fact-chip">👤 {player.displayName}</span>
            <span className="fact-chip">{player.posterOptIn ? "🖼 ✓" : "🖼 ✗"}</span>
            {canJoin ? (
              <button type="button" className="btn btn-small" onClick={() => setEditing(true)}>
                {t("en", "join.edit")}
              </button>
            ) : null}
          </p>
        </section>
        <SubmitPanel slug={slug} canSubmit={canJoin} onHasPhoto={setPhotoDone} />
      </>
    );
  }

  return (
    <>
    <Steps current={1} />
    <form className="card" onSubmit={onSubmit}>
      <h2>{t("en", "join.title")}</h2>
      <div className="field">
        <label htmlFor="join-name">{t("en", "join.name")}</label>
        <input
          id="join-name"
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          placeholder={t("en", "join.namePlaceholder")}
          autoComplete="nickname"
          maxLength={31}
          required
        />
      </div>


      <label className="choice field">
        <input
          type="checkbox"
          checked={posterOptIn}
          onChange={(event) => setPosterOptIn(event.target.checked)}
        />
        <span>{t("en", "join.poster")}</span>
      </label>

      <details className="field">
        <summary>{t("en", "join.pinSummary")}</summary>
        <label htmlFor="reclaim-pin">{t("en", "join.pin")}</label>
        <input
          id="reclaim-pin"
          value={reclaimPin}
          onChange={(event) => setReclaimPin(event.target.value.replace(/\D/g, "").slice(0, 4))}
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="1234"
        />
        <p className="field-help">{t("en", "join.pinHelp")}</p>
      </details>

      {error ? <p className="error" role="alert">{error}</p> : null}
      <button className="btn btn-primary" type="submit" disabled={busy || !displayName.trim()}>
        {busy ? t("en", "join.saving") : player ? t("en", "join.update") : t("en", "join.submit")}
      </button>
    </form>
    </>
  );
}
