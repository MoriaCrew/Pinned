import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { t } from "../../../i18n";
import { getBoardTheme, storedThemeId } from "../../../domain/board-themes";
import { getGameRepository } from "../../../server/repository";
import { getConfig } from "../../../config";
import { playerCookieName, publicPlayer, resolvePlayerSession } from "../../../server/player-session";
import type { CSSProperties } from "react";
import { JoinPanel } from "./JoinPanel";
import { LocalDeadline } from "./LocalDeadline";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Pinneds board",
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

// PIN-52 seam: existing games keep rendering here (read + join +
// photo intake) until the Studio board page replaces this (PIN-66).
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
  const boardTheme = getBoardTheme(storedThemeId(game));

  return (
    <div className="theme-bg" style={themeVars(game.theme)}>
    <main>
      <p className="eyebrow"><a href="/">📌 Pinneds</a></p>

      <section className="card">
        <p className="eyebrow">{t("en", "game.challenge")}</p>
        {boardTheme ? (
          // eslint-disable-next-line @next/next/no-img-element -- static baked asset
          <img className="theme-art" src={boardTheme.image} alt="" aria-hidden="true" width={512} height={512} />
        ) : null}
        <h1 className="challenge">“{game.challenge}”</h1>
        <p className="fact-chips">
          {boardTheme ? (
            <span className="fact-chip">{boardTheme.motif} {boardTheme.label}</span>
          ) : null}
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
    </main>
    </div>
  );
}
