/**
 * How much of the layout viewport's bottom the on-screen keyboard
 * covers (PIN-226). iOS Safari and Chrome on Android lay the keyboard
 * over the page and shrink only the visual viewport, so a bottom
 * sheet pinned to the layout viewport ends up under the keyboard.
 * The gap between the visual viewport's bottom edge and the layout
 * viewport's is the lift the sheet needs. Measured, never configured:
 * there is no limit to tune here.
 */
export interface ViewportSample {
  /** `window.innerHeight`: the layout viewport, which the keyboard does not resize. */
  innerHeight: number;
  /** `visualViewport.height`: what is still visible above the keyboard. */
  vvHeight: number;
  /** `visualViewport.offsetTop`: how far the browser scrolled the visible part down. */
  vvOffsetTop: number;
  /** `visualViewport.scale`: above 1 while pinch-zoomed. */
  scale: number;
}

/**
 * Pixels to lift the sheet by, rounded. 0 with the keyboard closed,
 * while pinch-zoomed (the visual viewport is smaller because of the
 * zoom, not a keyboard) and for any reading that makes no sense.
 */
export function keyboardInset({ innerHeight, vvHeight, vvOffsetTop, scale }: ViewportSample): number {
  if (![innerHeight, vvHeight, vvOffsetTop, scale].every(Number.isFinite)) return 0;
  if (innerHeight <= 0 || vvHeight <= 0 || scale <= 0) return 0;
  if (scale > 1) return 0;
  return Math.max(0, Math.round(innerHeight - vvHeight - vvOffsetTop));
}
