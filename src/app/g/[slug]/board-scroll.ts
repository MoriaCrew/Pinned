/**
 * Where the board scrolls and who gets focus when a scene starts or
 * picking begins (PIN-215, docs/11 §6: waiting is always visible).
 * DOM only, called from effects and handlers, never while rendering.
 */

/** The Scenes heading's id (BoardScenes); it takes focus from script. */
const SCENES_HEADING_ID = "board-scenes";

/** A pin's vertical extent on screen (getBoundingClientRect top/bottom). */
export interface PinBox {
  id: string;
  top: number;
  bottom: number;
}

/** Smooth, except for people who asked for less motion. */
export function scrollBehaviorFor(reducedMotion: boolean): ScrollBehavior {
  return reducedMotion ? "auto" : "smooth";
}

export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/**
 * The pin at the middle of the screen, or null when the middle of the
 * screen is not over the pins grid (the top of the board, say). Picking
 * hides the Scenes and the Things heading, which moves the grid; the
 * caller scrolls this pin back to the middle so the board stays put.
 * Between two rows it is the pin whose middle is nearest.
 */
export function pinAtScreenMiddle(pins: readonly PinBox[], viewportHeight: number): string | null {
  const middle = viewportHeight / 2;
  let nearest: { id: string; distance: number } | null = null;
  let gridTop = Infinity;
  let gridBottom = -Infinity;
  for (const pin of pins) {
    gridTop = Math.min(gridTop, pin.top);
    gridBottom = Math.max(gridBottom, pin.bottom);
    const distance = Math.abs((pin.top + pin.bottom) / 2 - middle);
    if (!nearest || distance < nearest.distance) nearest = { id: pin.id, distance };
  }
  return nearest && middle >= gridTop && middle <= gridBottom ? nearest.id : null;
}

/** `pinAtScreenMiddle` over the pins on the page right now. */
export function pinInMiddleOfScreen(
  doc: Pick<Document, "querySelectorAll">,
  viewportHeight: number,
): string | null {
  const boxes = Array.from(doc.querySelectorAll<HTMLElement>("[data-pin-id]"), (element) => {
    const { top, bottom } = element.getBoundingClientRect();
    return { id: element.dataset.pinId ?? "", top, bottom };
  });
  return pinAtScreenMiddle(boxes, viewportHeight);
}

/**
 * After "Make it": bring the Scenes section to the top of the screen,
 * wind its strip back to the newest print (the developing one), and
 * give the heading focus without a second scroll. False when the
 * section is not on the page.
 */
export function revealScenes(
  doc: Pick<Document, "getElementById">,
  reducedMotion: boolean,
): boolean {
  const heading = doc.getElementById(SCENES_HEADING_ID);
  if (!heading) return false;
  const behavior = scrollBehaviorFor(reducedMotion);
  heading.scrollIntoView({ block: "start", behavior });
  heading.closest("section")?.querySelector("ul")?.scrollTo({ left: 0, behavior });
  heading.focus({ preventScroll: true });
  return true;
}
