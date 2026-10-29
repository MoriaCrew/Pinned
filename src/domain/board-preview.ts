/**
 * Pure board link-preview + scene share logic (PIN-72, docs/11
 * section 6): which scene a chat preview shows, the absolute
 * preview URLs, and how a Share tap degrades (image file ->
 * page link -> download). Kept free of server/browser imports so
 * the picker is unit-tested like make-sheet (PIN-70).
 */
import type { SceneStatus } from "./board";

/** Structural slice of domain Scene the preview picker needs. */
export interface PreviewSceneLike {
  id: string;
  status: SceneStatus;
  hidden?: boolean;
  imageRef?: string;
  prompt: string;
  createdAt: number;
}

/** Branded card served from public/ when a board has no scene yet. */
export const FALLBACK_PREVIEW_IMAGE_PATH = "/og-card.png";

/**
 * Latest scene a link preview may show: ready, not hidden (a used
 * element was deleted, docs/11 section 5.4) and actually holding a
 * stored image. Only scenes/ refs qualify — the image route
 * enforces the same rule, so a preview can never point at a
 * candidate element or a tmp/ working copy. Ties break on id for
 * stability, mirroring scenesNewestFirst.
 */
export function pickLatestPreviewScene<T extends PreviewSceneLike>(
  scenes: readonly T[],
): T | null {
  let best: T | null = null;
  for (const scene of scenes) {
    if (scene.status !== "ready" || scene.hidden) continue;
    if (!scene.imageRef || !scene.imageRef.startsWith("scenes/")) continue;
    if (
      !best ||
      scene.createdAt > best.createdAt ||
      (scene.createdAt === best.createdAt && scene.id.localeCompare(best.id) > 0)
    ) {
      best = scene;
    }
  }
  return best;
}

export interface BoardPreview {
  title: string;
  description: string;
  /** Absolute board page URL (og:url). */
  pageUrl: string;
  /** Absolute og:image — latest scene image route or branded card. */
  imageUrl: string;
  /** The picked scene id, or null when the fallback card is used. */
  sceneId: string | null;
}

function trimOrigin(origin: string): string {
  return origin.replace(/\/+$/, "");
}

/**
 * Preview fields for generateMetadata. `origin` must come from the
 * public-origin helper (never raw request headers at a call site).
 * Description is the picked scene's prompt; with no usable scene
 * the caller's board description (i18n) is used instead.
 */
export function buildBoardPreview(input: {
  boardTitle: string;
  slug: string;
  origin: string;
  scenes: readonly PreviewSceneLike[];
  fallbackDescription: string;
}): BoardPreview {
  const origin = trimOrigin(input.origin);
  const scene = pickLatestPreviewScene(input.scenes);
  return {
    title: input.boardTitle,
    description: scene ? scene.prompt : input.fallbackDescription,
    pageUrl: `${origin}/g/${encodeURIComponent(input.slug)}`,
    imageUrl: scene
      ? `${origin}/api/boards/${encodeURIComponent(input.slug)}/scenes/${encodeURIComponent(scene.id)}/image`
      : `${origin}${FALLBACK_PREVIEW_IMAGE_PATH}`,
    sceneId: scene?.id ?? null,
  };
}

export type ShareAction = "files" | "url" | "download";

/**
 * Share degradation ladder (PIN-72): the scene image as a File
 * when the browser can share files, else the board link/text via
 * the share sheet, else a plain download. The client computes the
 * two capability flags from navigator.canShare; this stays pure.
 */
export function chooseShareAction(capabilities: {
  canShareFiles: boolean;
  canShareUrl: boolean;
}): ShareAction {
  if (capabilities.canShareFiles) return "files";
  if (capabilities.canShareUrl) return "url";
  return "download";
}

const SHARE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

/** Download / shared-file name for a scene image. */
export function sceneShareFilename(sceneId: string, contentType: string): string {
  const ext = SHARE_EXTENSIONS[contentType.split(";")[0]?.trim() ?? ""] ?? "png";
  const safeId = sceneId.replace(/[^a-zA-Z0-9_-]/g, "-");
  return `pinneds-scene-${safeId}.${ext}`;
}
