"use client";

import { useState, type FormEvent } from "react";
import { t } from "../../../i18n";
import type { RoastLevel } from "../../../domain/types";

export interface JoinPlayerView {
  id: string;
  displayName: string;
  roastLevel: RoastLevel;
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
  const [roastLevel, setRoastLevel] = useState<RoastLevel>(initialPlayer?.roastLevel ?? "spicy");
  const [posterOptIn, setPosterOptIn] = useState(initialPlayer?.posterOptIn ?? true);
  const [reclaimPin, setReclaimPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

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
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/games/${encodeURIComponent(slug)}/players`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName,
          roastLevel,
          posterOptIn,
          reclaimPin: reclaimPin || undefined,
        }),
      });
      const data = (await response.json()) as { player?: JoinPlayerView; error?: string };
      if (!response.ok || !data.player) throw new Error(data.error || t("en", "join.error"));
      setPlayer(data.player);
      setDisplayName(data.player.displayName);
      setRoastLevel(data.player.roastLevel);
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
      <section className="card" aria-live="polite">
        <p className="eyebrow">{t("en", "join.ready")}</p>
        <h2>{player.displayName}</h2>
        <p>{t("en", "join.readyBody")}</p>
        <dl className="facts">
          <div>
            <dt>{t("en", "join.roastChosen")}</dt>
            <dd>{t("en", `join.${player.roastLevel}`)}</dd>
          </div>
          <div>
            <dt>Poster</dt>
            <dd>{player.posterOptIn ? t("en", "join.posterChosen") : t("en", "join.posterSkipped")}</dd>
          </div>
        </dl>
        {canJoin ? (
          <button type="button" className="btn" onClick={() => setEditing(true)}>
            {t("en", "join.edit")}
          </button>
        ) : null}
      </section>
    );
  }

  return (
    <form className="card" onSubmit={onSubmit}>
      <h2>{t("en", "join.title")}</h2>
      <p>{t("en", "join.intro")}</p>
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

      <fieldset className="field">
        <legend>{t("en", "join.roast")}</legend>
        {(["gentle", "spicy", "feral"] as const).map((level) => (
          <label className="choice" key={level}>
            <input
              type="radio"
              name="roast-level"
              value={level}
              checked={roastLevel === level}
              onChange={() => setRoastLevel(level)}
            />
            <span>{t("en", `join.${level}`)}</span>
          </label>
        ))}
      </fieldset>

      <label className="choice field">
        <input
          type="checkbox"
          checked={posterOptIn}
          onChange={(event) => setPosterOptIn(event.target.checked)}
        />
        <span>{t("en", "join.poster")}</span>
      </label>

      <div className="field">
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
      </div>

      {error ? <p className="error" role="alert">{error}</p> : null}
      <button className="btn btn-primary" type="submit" disabled={busy || !displayName.trim()}>
        {busy ? t("en", "join.saving") : player ? t("en", "join.update") : t("en", "join.submit")}
      </button>
    </form>
  );
}
