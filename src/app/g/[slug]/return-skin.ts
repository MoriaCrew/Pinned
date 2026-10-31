import { isPlusSkinId, isSkinId, type SkinId } from "../../../domain/skins";

/**
 * The Plus look a host was trying on when they left for Stripe
 * (PIN-182), kept in sessionStorage next to the makes baseline so the
 * return can put it on the board. `returned` is set the moment this
 * tab lands back with the processing flag, so a reload after that
 * still applies the look, while an abandoned Checkout visit (no
 * return) never does, whoever grants Plus later. Read only inside
 * effects, never while rendering (the server render cannot know it).
 */
export interface ReturnSkin {
  skin: SkinId;
  returned: boolean;
}

const returnSkinKey = (slug: string) => `pinned.returnSkin:${slug}`;

/** The stored try-on, or null when none, junk, or storage is blocked. */
export function readReturnSkin(slug: string): ReturnSkin | null {
  try {
    const raw = window.sessionStorage.getItem(returnSkinKey(slug));
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { skin, returned } = parsed as { skin?: unknown; returned?: unknown };
    return isSkinId(skin) && isPlusSkinId(skin) ? { skin, returned: returned === true } : null;
  } catch {
    return null;
  }
}

/** Store the try-on as "left for Checkout" (not returned yet), or clear it with null. */
export function writeReturnSkin(slug: string, skin: SkinId | null) {
  try {
    if (skin === null) window.sessionStorage.removeItem(returnSkinKey(slug));
    else window.sessionStorage.setItem(returnSkinKey(slug), JSON.stringify({ skin, returned: false }));
  } catch {
    // Private mode: the host just picks the look again after the return.
  }
}

/** This tab came back from Checkout: the stored look may now apply, even after a reload. */
export function markReturnSkinReturned(slug: string) {
  const stored = readReturnSkin(slug);
  if (!stored || stored.returned) return;
  try {
    window.sessionStorage.setItem(returnSkinKey(slug), JSON.stringify({ skin: stored.skin, returned: true }));
  } catch {
    // Without storage the processing flag still carries this visit.
  }
}
