/**
 * Scene viewer state (PIN-131): `?scene={sceneId}` on the board URL
 * opens that print full screen. Pure, so the board reads and writes
 * the address bar through these and steps through the strip's
 * prints the same way the tests do.
 */
import type { StripItem } from "./board-ui";

export const SCENE_PARAM = "scene";

/** The scene id a `?scene=` value names: the first one when repeated, null when missing or blank. */
export function parseSceneParam(value: string | readonly string[] | null | undefined): string | null {
  const first = typeof value === "string" ? value : value?.[0];
  return first?.trim() || null;
}

/** The `?scene=` id in an absolute URL, or null. */
export function sceneIdInUrl(href: string): string | null {
  return parseSceneParam(new URL(href).searchParams.get(SCENE_PARAM));
}

/** The absolute URL with `?scene=` set to `sceneId` (or removed for null); other params and the hash are kept. */
export function urlWithScene(href: string, sceneId: string | null): string {
  const url = new URL(href);
  if (sceneId) url.searchParams.set(SCENE_PARAM, sceneId);
  else url.searchParams.delete(SCENE_PARAM);
  return url.href;
}

/** What the viewer can show and step through: the strip's prints only, in strip order (newest first). */
export function viewerSceneIds(items: readonly StripItem[]): string[] {
  return items.filter((item) => item.mode === "print").map((item) => item.scene.id);
}

/** The print `step` away (+1 = next, older), or null at either end and for an id that is not viewable. */
export function stepScene(ids: readonly string[], current: string, step: 1 | -1): string | null {
  const index = ids.indexOf(current);
  return index < 0 ? null : (ids[index + step] ?? null);
}
