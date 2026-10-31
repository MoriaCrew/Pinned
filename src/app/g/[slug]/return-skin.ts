import { isPlusSkinId, isSkinId, type SkinId } from "../../../domain/skins";

/**
 * The Plus look a host was trying on when they left for Stripe
 * (PIN-182), kept in sessionStorage next to the makes baseline so the
 * return can put it on the board. Read only inside effects, never
 * while rendering (the server render cannot know it).
 */
const returnSkinKey = (slug: string) => `pinned.returnSkin:${slug}`;

/** The stored try-on, or null when none, junk, or storage is blocked. */
export function readReturnSkin(slug: string): SkinId | null {
  try {
    const raw = window.sessionStorage.getItem(returnSkinKey(slug));
    return isSkinId(raw) && isPlusSkinId(raw) ? raw : null;
  } catch {
    return null;
  }
}

/** Store the try-on, or clear it with null. */
export function writeReturnSkin(slug: string, skin: SkinId | null) {
  try {
    if (skin === null) window.sessionStorage.removeItem(returnSkinKey(slug));
    else window.sessionStorage.setItem(returnSkinKey(slug), skin);
  } catch {
    // Private mode: the host just picks the look again after the return.
  }
}
