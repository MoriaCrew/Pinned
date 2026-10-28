"use client";

import { useId, useRef, useEffect, useState, type FormEvent } from "react";
import { t } from "../../i18n";
import { HOST_PRESETS, type HostPreset } from "../../domain/presets";
import type { HostPersona } from "../../gateway/model-gateway";

type Deadline = "express" | "evening" | "24h" | "custom";

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
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const id = useId();

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
      window.setTimeout(() => setState("idle"), 1600);
    } catch {
      setState("failed");
    }
  }

  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="copy-row">
        <textarea id={id} readOnly rows={rows} value={value} onFocus={(event) => event.target.select()} />
        <button type="button" className="btn btn-small" onClick={copy}>
          {state === "copied" ? t("en", "create.copied") : t("en", "create.copy")}
        </button>
      </div>
      {state === "failed" ? (
        <p className="field-help" role="status">{t("en", "create.copyFailed")}</p>
      ) : null}
    </div>
  );
}

function PresetCard({
  preset,
  selected,
  onSelect,
}: {
  preset: HostPreset;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={selected ? "preset-card selected" : "preset-card"}
      role="radio"
      aria-checked={selected}
      tabIndex={selected ? 0 : -1}
      onClick={onSelect}
      style={{
        background: `linear-gradient(150deg, ${preset.theme.paper} 55%, ${preset.theme.line})`,
        borderColor: selected ? preset.theme.accent : undefined,
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- static baked asset */}
      <img className="preset-art" src={preset.image} alt="" aria-hidden="true" width={512} height={512} />
      <span className="preset-name">{preset.persona.name}</span>
      <span className="preset-catch">{preset.catchline}</span>
      {selected ? <span className="preset-check" aria-hidden="true">✓</span> : null}
    </button>
  );
}

function themeStyle(theme: HostPreset["theme"]): React.CSSProperties {
  return {
    "--paper": theme.paper,
    "--accent": theme.accent,
    "--line": theme.line,
  } as React.CSSProperties;
}

export function CreateGameForm() {
  const [presetId, setPresetId] = useState<string>(HOST_PRESETS[0].id);
  const activePreset = HOST_PRESETS.find((preset) => preset.id === presetId) ?? HOST_PRESETS[0];
  const [invent, setInvent] = useState(false);
  const [brief, setBrief] = useState("");
  const [deadline, setDeadline] = useState<Deadline>("express");
  const [customHours, setCustomHours] = useState(6);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<CreatedGame | null>(null);
  const resultRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (result) resultRef.current?.focus();
  }, [result]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/games", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(invent ? { brief } : { presetId }),
          deadlinePreset: deadline,
          customHours: deadline === "custom" ? customHours : undefined,
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
      <section className="card" aria-live="polite" tabIndex={-1} ref={resultRef}>
        <h2>{t("en", "create.resultTitle")}</h2>
        <p>{t("en", "create.resultIntro")}</p>
        <div className="persona-card">
          <p className="eyebrow">{t("en", "game.host")}</p>
          <h3>{game.persona.name}</h3>
          <p className="challenge">“{game.challenge}”</p>
          <p><strong>{t("en", "create.deadline")}:</strong> {formatDeadline(game.deadlineAt)}</p>
        </div>
        <CopyField label={t("en", "create.playerLink")} value={result.playerUrl} rows={2} />
        <CopyField label={t("en", "create.adminLink")} value={result.adminUrl} rows={3} />
        <CopyField label={t("en", "create.invite")} value={`Pinneds: ${game.persona.name} is hosting a photo game. Challenge: ${game.challenge} Join before ${formatDeadline(game.deadlineAt)}: ${result.playerUrl}`} rows={4} />
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
    <form className="card themed" onSubmit={onSubmit} style={invent ? undefined : themeStyle(activePreset.theme)}>
      <fieldset className="field">
        <legend>{t("en", "create.pickHost")}</legend>
        <div className="preset-grid" role="radiogroup" aria-label={t("en", "create.pickHost")}
          onKeyDown={(event) => {
            const keys = ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"];
            if (!keys.includes(event.key)) return;
            event.preventDefault();
            const options = [...HOST_PRESETS.map((preset) => preset.id), "invent"];
            const current = invent ? "invent" : presetId;
            const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1;
            const next = options[(options.indexOf(current) + step + options.length) % options.length];
            if (next === "invent") setInvent(true); else { setInvent(false); setPresetId(next); }
            requestAnimationFrame(() => {
              const group = event.currentTarget;
              group.querySelector<HTMLElement>("[aria-checked='true']")?.focus();
            });
          }}
        >
          {HOST_PRESETS.map((preset) => (
            <PresetCard
              key={preset.id}
              preset={preset}
              selected={!invent && presetId === preset.id}
              onSelect={() => {
                setInvent(false);
                setPresetId(preset.id);
              }}
            />
          ))}
          <button
            type="button"
            className={invent ? "preset-card selected" : "preset-card"}
            role="radio"
            aria-checked={invent}
            tabIndex={invent ? 0 : -1}
            onClick={() => setInvent(true)}
          >
            <span className="preset-motif" aria-hidden="true">✨</span>
            <span className="preset-name">{t("en", "create.invent")}</span>
            <span className="preset-catch">{t("en", "create.inventCatch")}</span>
            {invent ? <span className="preset-check" aria-hidden="true">✓</span> : null}
          </button>
        </div>
      </fieldset>

      {invent ? (
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
          <div className="lab-chips">
            {(["create.example1", "create.example2", "create.example3"] as const).map((key) => (
              <button key={key} type="button" className="chip" onClick={() => setBrief(t("en", key))}>
                {t("en", key)}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <fieldset className="field">
        <legend>{t("en", "create.deadlineLegend")}</legend>
        <div className="choice-cards">
          {([
            ["express", "create.express"],
            ["evening", "create.evening"],
            ["24h", "create.day"],
            ["custom", "create.custom"],
          ] as const).map(([value, label]) => (
            <label className="choice-card" key={value}>
              <input
                type="radio"
                name="deadline"
                value={value}
                checked={deadline === value}
                onChange={() => setDeadline(value)}
              />
              <span>{t("en", label)}</span>
            </label>
          ))}
        </div>
      </fieldset>

      {deadline === "custom" ? (
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
      <button className="btn btn-primary" type="submit" disabled={busy || (invent && !brief.trim())}>
        {busy ? t("en", invent ? "create.working" : "create.workingPreset") : t("en", "create.submit")}
      </button>
    </form>
  );
}
