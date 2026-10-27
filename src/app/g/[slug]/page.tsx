import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { t } from "../../../i18n";
import { getGameRepository } from "../../../server/repository";
import { getConfig } from "../../../config";
import { playerCookieName, publicPlayer, resolvePlayerSession } from "../../../server/player-session";
import type { CSSProperties } from "react";
import { JoinPanel } from "./JoinPanel";
import { LocalDeadline } from "./LocalDeadline";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Pinned game",
  robots: { index: false, follow: false },
};

function themeVars(theme: { accent: string; accentInk: string; paper: string; line: string } | undefined): CSSProperties {
  if (!theme) return {};
  return {
    "--accent": theme.accent,
    "--accent-ink": theme.accentInk,
    "--paper": theme.paper,
    "--line": theme.line,
  } as CSSProperties;
}

export default async function GamePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const repository = getGameRepository();
  const game = await repository.getGame(slug);
  if (!game) notFound();
  const cookieStore = await cookies();
  const currentPlayer = await resolvePlayerSession(
    slug,
    cookieStore.get(playerCookieName(slug))?.value ?? null,
    { repository, sessionSecret: getConfig().sessionSecret },
  );
  const canJoin = game.state === "OPEN" && Date.now() < game.deadlineAt;

  return (
    <div className="theme-bg" style={themeVars(game.theme)}>
    <main>
      <p className="eyebrow"><a href="/">📌 Pinned</a></p>

      <section className="card">
        <p className="eyebrow">{t("en", "game.challenge")}</p>
        <h1 className="challenge">“{game.challenge}”</h1>
        <p className="fact-chips">
          <span className="fact-chip">{game.theme?.motif ?? "🎭"} {game.persona.name}</span>
          <span className="fact-chip">
            {t("en", "game.deadline")}{" "}
            <LocalDeadline value={game.deadlineAt} />
          </span>
          <span className="fact-chip">{game.entryCount} {t("en", "game.entries")}</span>
        </p>
      </section>

      <JoinPanel
        slug={slug}
        initialPlayer={currentPlayer ? publicPlayer(currentPlayer) : null}
        canJoin={canJoin}
      />

      <details className="card">
        <summary>{t("en", "game.meetHost")}</summary>
        <p>{game.persona.judgingStyle}</p>
        <h3>{t("en", "game.rubricTitle")}</h3>
        <ul className="plain-list">
          <li>{t("en", "game.rubricFit")}</li>
          <li>{t("en", "game.rubricEffort")}</li>
          <li>{t("en", "game.rubricChaos")}</li>
        </ul>
        <p>{t("en", "game.rubricNote")}</p>
        <h3>{t("en", "game.voice")}</h3>
        <ul className="plain-list">
          {game.persona.voiceRules.map((rule) => <li key={rule}>{rule}</li>)}
        </ul>
        {game.persona.catchphrases.length > 0 ? (
          <>
            <h3>{t("en", "game.catchphrases")}</h3>
            <ul className="plain-list">
              {game.persona.catchphrases.map((phrase) => <li key={phrase}>{phrase}</li>)}
            </ul>
          </>
        ) : null}
      </details>
    </main>
    </div>
  );
}
