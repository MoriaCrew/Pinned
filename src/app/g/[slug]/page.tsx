import type { Metadata } from "next";
import type { CSSProperties } from "react";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { getBoardTheme } from "../../../domain/board-themes";
import { isValidSlug } from "../../../domain/tokens";
import { getPolicy } from "../../../policy/server";
import { getBoardView } from "../../../server/board-api";
import { getBoardRepository } from "../../../server/board-repository";
import {
  playerCookieName,
  resolveParticipantSession,
} from "../../../server/board-session";
import { getConfig } from "../../../config";
import { boardApiDeps, policyForBoard } from "../../api/boards/shared";
import { BoardClient, type BoardClientView } from "./BoardClient";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Pinneds board",
  robots: { index: false, follow: false },
};

function themeVars(
  theme: { accent: string; accentInk: string; paper: string; line: string } | null | undefined,
): CSSProperties {
  if (!theme) return {};
  return {
    "--accent": theme.accent,
    "--accent-ink": theme.accentInk,
    "--paper": theme.paper,
    "--line": theme.line,
  } as CSSProperties;
}

/**
 * Studio board page (PIN-66, docs/11 section 6). Replaces the
 * game read-path: boards live in `boards/` (PIN-62/63), so an
 * old game slug with no Studio board is a plain 404 here (the
 * accepted post-PIN-52 break). Slug shape is checked before any
 * repository read, mirroring the API slug gate.
 */
export default async function BoardPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  if (!isValidSlug(slug)) notFound();

  const boards = getBoardRepository();
  const board = await boards.getBoard(slug);
  if (!board) notFound();

  const policy = await policyForBoard(slug);
  const cookieStore = await cookies();
  const viewer = await resolveParticipantSession(
    slug,
    cookieStore.get(playerCookieName(slug))?.value ?? null,
    { boards, sessionSecret: getConfig().sessionSecret, policy },
  ).catch(() => null);
  const view = await getBoardView(slug, viewer, boardApiDeps(policy));
  if (!view) notFound();

  const theme = getBoardTheme(board.themeId);

  return (
    <div className="theme-bg" style={themeVars(theme?.tokens ?? board.theme)}>
      <main className="board-main">
        <p className="eyebrow"><a href="/">📌 Pinneds</a></p>
        <section className="card">
          {theme ? (
            // eslint-disable-next-line @next/next/no-img-element -- static baked asset
            <img className="theme-art" src={theme.image} alt="" aria-hidden="true" width={512} height={512} />
          ) : null}
          <h1 className="challenge">{board.title}</h1>
          {theme ? (
            <p className="fact-chips">
              <span className="fact-chip">{theme.motif} {theme.label}</span>
            </p>
          ) : null}
        </section>
        <BoardClient
          slug={slug}
          initialView={view as BoardClientView}
          pollIntervalMs={getPolicy(board.policyOverrides ?? null).boardPollIntervalMs}
        />
      </main>
    </div>
  );
}
