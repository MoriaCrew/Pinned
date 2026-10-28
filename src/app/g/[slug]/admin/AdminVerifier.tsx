"use client";

import { useEffect, useState } from "react";
import { t } from "../../../../i18n";

interface AdminGame {
  challenge: string;
  deadlineAt: number;
  entryCount: number;
  state: string;
  persona: { name: string };
}

const memoryTokens = new Map<string, string>();

function captureAdminToken(slug: string): string {
  const storageKey = `pinned-admin:${slug}`;
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const fromFragment = fragment.get("token") ?? "";
  if (fromFragment) {
    memoryTokens.set(slug, fromFragment);
    try {
      window.sessionStorage.setItem(storageKey, fromFragment);
      } catch (error) {
      // In-memory capture still covers remounts in this page lifetime.
    }
    window.history.replaceState(null, "", window.location.pathname);
    return fromFragment;
  }

  const remembered = memoryTokens.get(slug);
  if (remembered) return remembered;
  try {
    return window.sessionStorage.getItem(storageKey) ?? "";
      } catch (error) {
    return "";
  }
}

function forgetAdminToken(slug: string): void {
  memoryTokens.delete(slug);
  try {
    window.sessionStorage.removeItem(`pinned-admin:${slug}`);
      } catch (error) {
    // Nothing else to do if storage is unavailable.
  }
}

export function AdminVerifier({ slug }: { slug: string }) {
  const [game, setGame] = useState<AdminGame | null>(null);
  const [copied, setCopied] = useState(false);
  const [failure, setFailure] = useState<"invalid" | "unavailable" | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const token = captureAdminToken(slug);
    if (!token) {
      setFailure("invalid");
      return;
    }

    let cancelled = false;
    async function verify() {
      try {
        const response = await fetch(`/api/games/${encodeURIComponent(slug)}/admin`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ adminToken: token }),
        });
        if (response.status === 401) {
          // Only an explicit credential rejection may discard the token.
          forgetAdminToken(slug);
          throw new Error("invalid");
        }
        if (!response.ok) throw new Error("transient");
        const data = (await response.json()) as { game: AdminGame };
        if (!cancelled) setGame(data.game);
      } catch (error) {
        // Network/5xx failures keep the captured token for a retry.
        if (!cancelled) setFailure(error instanceof Error && error.message === "invalid" ? "invalid" : "unavailable");
      }
    }
    void verify();
    return () => {
      cancelled = true;
    };
  }, [slug, attempt]);

  if (failure === "invalid") return <p className="error" role="alert">{t("en", "admin.invalid")}</p>;
  if (failure === "unavailable") {
    return (
      <section className="card">
        <p className="error" role="alert">{t("en", "admin.unavailable")}</p>
        <button type="button" className="btn btn-primary" onClick={() => { setFailure(null); setAttempt((n) => n + 1); }}>{t("en", "admin.retry")}</button>
      </section>
    );
  }
  if (!game) return <p>{t("en", "admin.loading")}</p>;

  return (
    <section className="card">
      <p className="state-pill">{game.state}</p>
      <h2>{game.persona.name}</h2>
      <p className="challenge">“{game.challenge}”</p>
      <dl className="facts">
        <div>
          <dt>{t("en", "game.deadline")}</dt>
          <dd>{new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(game.deadlineAt)}</dd>
        </div>
        <div>
          <dt>{t("en", "game.entries")}</dt>
          <dd>{game.entryCount}</dd>
        </div>
      </dl>
      <p className="notice">{t("en", "admin.ready")}</p>
      <h3>{t("en", "admin.nudge")}</h3>
      <button
        type="button"
        className="btn btn-primary"
        onClick={async () => {
          const when = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(game.deadlineAt);
          const link = `${window.location.origin}/g/${slug}`;
          try {
            await navigator.clipboard.writeText(`${t("en", "admin.nudgeText")} ${game.challenge} Ends ${when}: ${link}`);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1600);
          } catch { /* clipboard unavailable; the open-game link below still works */ }
        }}
      >
        {copied ? t("en", "create.copied") : t("en", "admin.nudgeCopy")}
      </button>
      <a className="btn btn-primary" href={`/g/${slug}`}>{t("en", "admin.openPlayer")}</a>
    </section>
  );
}
