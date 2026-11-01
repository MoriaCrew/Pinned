/**
 * Scene print shape (PIN-129). Pure and client-safe: the board strip
 * and the make sheet size each print's frame from the scene's stored
 * pixel size, so the whole picture shows (no crop of a tall scene).
 * Scenes stored before sizes were recorded, and slots whose image has
 * not landed yet, take the shape of Policy.sceneSize.
 */

export interface SceneSize {
  width: number;
  height: number;
}

const SCENE_SIZE = /^(\d+)x(\d+)$/;

function isSide(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Policy.sceneSize ("1024x1536") -> pixel size, or null. */
export function parseSceneSize(size: string): SceneSize | null {
  const match = SCENE_SIZE.exec(size.trim());
  if (!match) return null;
  return validSceneSize({ width: Number(match[1]), height: Number(match[2]) });
}

/** A stored size both of whose sides are positive integers, or null. */
export function validSceneSize(
  size: { width?: unknown; height?: unknown } | null | undefined,
): SceneSize | null {
  if (!size || !isSide(size.width) || !isSide(size.height)) return null;
  return { width: size.width, height: size.height };
}

/**
 * CSS aspect-ratio ("w / h") for a scene print: its stored size when
 * valid, else Policy.sceneSize. The Policy schema rejects a malformed
 * sceneSize, so "auto" (the frame follows the image itself) is only a
 * type-level answer, never a made-up ratio.
 */
export function sceneRatio(
  size: { width?: unknown; height?: unknown } | null | undefined,
  policySceneSize: string,
): string {
  const dims = validSceneSize(size) ?? parseSceneSize(policySceneSize);
  return dims ? `${dims.width} / ${dims.height}` : "auto";
}
