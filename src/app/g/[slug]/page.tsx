import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { notFound } from "next/navigation";
import { buildBoardPreview } from "../../../domain/board-preview";
import { isSkinId, skinForTheme } from "../../../domain/skins";
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
 * Link preview (PIN-72, docs/11 section 6): title/description
 * here; since PIN-102 the OG/Twitter image is the board card
 * (opengraph-image.tsx), resolved against the public origin. The slug
 * capability link is what a chat crawler already holds when it
 * fetches this page, so the card leaks nothing beyond board-visible
 * pins — never candidate elements or tmp/ refs. noindex is
 * preserved. Any failure degrades to the branded fallback instead
 * of breaking the page.
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
      // PIN-102: og:image / twitter:image come from the board card
      // (opengraph-image.tsx, twitter-image.tsx). Next only uses the
      // file convention when no `images` are set here, and resolves
      // its URL against metadataBase (the public origin).
      metadataBase: new URL(origin),
      title: preview.title,
      description: preview.description,
      robots: { index: false, follow: false },
      openGraph: {
        title: preview.title,
        description: preview.description,
        url: preview.pageUrl,
        type: "website",
      },
      twitter: {
        card: "summary_large_image",
        title: preview.title,
        description: preview.description,
      },
    };
  } catch {
    return fallback;
  }
}

/**
 * Studio board page (PIN-66, docs/11 section 6). Replaces the
 * game read-path: boards live in `boards/` (PIN-62/63), so an
 * old game slug with no Studio board is a plain 404 here (the
 * accepted post-PIN-52 break). Slug shape is checked before any
 * repository read, mirroring the API slug gate.
 *
 * PIN-98: the board renders in its skin (docs/14): the root carries
 * `data-theme` from `skinForTheme(board.themeId)`, so first-generation
 * theme ids map onto a free skin. `?tryon=<skin>` is read and passed
 * through for PIN-103 (no behaviour yet).
 */
export default async function BoardPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
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

  const resolved = getPolicy(board.policyOverrides ?? null);
  const skin = skinForTheme(board.themeId);
  const tryOnParam = (await searchParams).tryon;
  const tryOnSkin = isSkinId(tryOnParam) ? tryOnParam : null;

  return (
    <div className="pn-skin-root" data-theme={skin} style={{ minHeight: "100dvh" }}>
      <BoardClient
        slug={slug}
        initialView={view as BoardClientView}
        skin={skin}
        tryOnSkin={tryOnSkin}
        policy={{ pollIntervalMs: resolved.boardPollIntervalMs, jobPollIntervalMs: resolved.jobPollIntervalMs, uploadMaxPx: resolved.uploadMaxPx, uploadJpegQuality: resolved.uploadJpegQuality, pinsPerScene: resolved.pinsPerScene, sceneChips: resolved.sceneChips, scenePromptMaxChars: resolved.scenePromptMaxChars, elementsPerPhotoMax: resolved.elementsPerPhoto.max, signInNudge: resolved.signInNudge }}
      />
    </div>
  );
}
