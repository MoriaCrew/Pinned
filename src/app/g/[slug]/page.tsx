import type { Metadata } from "next";
import type { CSSProperties } from "react";
import { cookies, headers } from "next/headers";
import { notFound } from "next/navigation";
import { buildBoardPreview } from "../../../domain/board-preview";
import { getBoardTheme } from "../../../domain/board-themes";
import { isValidSlug } from "../../../domain/tokens";
import { t } from "../../../i18n";
import { getPolicy } from "../../../policy/server";
import { getBoardView } from "../../../server/board-api";
import { getBoardRepository } from "../../../server/board-repository";
import {
  playerCookieName,
  resolveParticipantSession,
} from "../../../server/board-session";
import { getPublicOriginFromHeaders } from "../../../server/public-origin";
import { getConfig } from "../../../config";
import { boardApiDeps, policyForBoard } from "../../api/boards/shared";
import { BoardClient, type BoardClientView } from "./BoardClient";

export const dynamic = "force-dynamic";

/**
 * Link preview (PIN-72, docs/11 section 6): OG/Twitter image is
 * the latest ready non-hidden scene via the board-link-checked
 * image route (absolute URL via the public-origin helper), or
 * the branded public/og-card.png when there is none. The slug
 * capability link is what a chat crawler already holds when it
 * fetches this page, so the image route leaks nothing beyond
 * board-visible scenes — never candidate elements or tmp/ refs
 * (pickLatestPreviewScene + resolveSceneImage both enforce
 * scenes/). noindex is preserved. Any failure degrades to the
 * branded fallback instead of breaking the page.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const fallback: Metadata = {
    title: "Pinneds board",
    description: t("en", "board.previewDescription"),
    robots: { index: false, follow: false },
  };
  try {
    const { slug } = await params;
    if (!isValidSlug(slug)) return fallback;
    const boards = getBoardRepository();
    const board = await boards.getBoard(slug);
    if (!board) return fallback;
    const scenes = await boards.listScenes(slug);
    const origin = getPublicOriginFromHeaders(
      await headers(),
      getConfig().appBaseUrl,
    );
    const preview = buildBoardPreview({
      boardTitle: board.title,
      slug,
      origin,
      scenes,
      fallbackDescription: t("en", "board.previewDescription"),
    });
    return {
      title: preview.title,
      description: preview.description,
      robots: { index: false, follow: false },
      openGraph: {
        title: preview.title,
        description: preview.description,
        url: preview.pageUrl,
        type: "website",
        images: [{ url: preview.imageUrl, alt: preview.description }],
      },
      twitter: {
        card: "summary_large_image",
        title: preview.title,
        description: preview.description,
        images: [preview.imageUrl],
      },
    };
  } catch {
    return fallback;
  }
}

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
  const resolved = getPolicy(board.policyOverrides ?? null);

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
          policy={{ pollIntervalMs: resolved.boardPollIntervalMs, jobPollIntervalMs: resolved.jobPollIntervalMs, uploadMaxPx: resolved.uploadMaxPx, uploadJpegQuality: resolved.uploadJpegQuality, pinsPerScene: resolved.pinsPerScene, sceneChips: resolved.sceneChips, scenePromptMaxChars: resolved.scenePromptMaxChars, elementsPerPhotoMax: resolved.elementsPerPhoto.max }}
        />
      </main>
    </div>
  );
}
