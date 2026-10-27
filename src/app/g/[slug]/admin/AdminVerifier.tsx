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

export function AdminVerifier({ slug }: { slug: string }) {
  const [game, setGame] = useState<AdminGame | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const token = fragment.get("token") ?? "";
    // Remove the credential from the address bar/history immediately.
    window.history.replaceState(null, "", window.location.pathname);

    let cancelled = false;
    async function verify() {
      try {
        const response = await fetch(`/api/games/${encodeURIComponent(slug)}/admin`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ adminToken: token }),
        });
        if (!response.ok) throw new Error("invalid");
        const data = (await response.json()) as { game: AdminGame };
        if (!cancelled) setGame(data.game);
      } catch {
        if (!cancelled) setFailed(true);
      }
    }
    void verify();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  if (failed) return <p className="error" role="alert">{t("en", "admin.invalid")}</p>;
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
      <a className="btn btn-primary" href={`/g/${slug}`}>{t("en", "admin.openPlayer")}</a>
    </section>
  );
}
