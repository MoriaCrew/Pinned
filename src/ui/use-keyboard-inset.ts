"use client";

import { useEffect, type RefObject } from "react";
import { keyboardInset } from "../domain/keyboard-inset";

/** The CSS variable a keyboard-aware sheet reads (`src/ui/pinneds.css`). */
export const KEYBOARD_INSET_VAR = "--pn-keyboard-inset";

/** The parts of `window`, `visualViewport` and the element the wiring touches (testable without a DOM). */
export interface InsetViewport {
  readonly height: number;
  readonly offsetTop: number;
  readonly scale: number;
  addEventListener(type: "resize" | "scroll", listener: () => void): void;
  removeEventListener(type: "resize" | "scroll", listener: () => void): void;
}
export interface InsetWindow {
  readonly innerHeight: number;
  readonly visualViewport?: InsetViewport | null;
  requestAnimationFrame(callback: () => void): number;
  cancelAnimationFrame(handle: number): void;
}
export interface InsetTarget {
  readonly style: { setProperty(name: string, value: string): void; removeProperty(name: string): unknown };
}

/**
 * Keeps `--pn-keyboard-inset` on `target` equal to the keyboard's
 * cover (PIN-226): measured once now, then on every visual viewport
 * `resize` and `scroll`, at most once per animation frame. Without
 * `visualViewport` it does nothing. Returns the cleanup.
 */
export function watchKeyboardInset(target: InsetTarget, win: InsetWindow): () => void {
  const viewport = win.visualViewport;
  if (!viewport) return () => {};
  let frame: number | null = null;
  const apply = () => {
    frame = null;
    const inset = keyboardInset({
      innerHeight: win.innerHeight,
      vvHeight: viewport.height,
      vvOffsetTop: viewport.offsetTop,
      scale: viewport.scale,
    });
    target.style.setProperty(KEYBOARD_INSET_VAR, `${inset}px`);
  };
  const schedule = () => {
    if (frame === null) frame = win.requestAnimationFrame(apply);
  };
  viewport.addEventListener("resize", schedule);
  viewport.addEventListener("scroll", schedule);
  schedule();
  return () => {
    viewport.removeEventListener("resize", schedule);
    viewport.removeEventListener("scroll", schedule);
    if (frame !== null) win.cancelAnimationFrame(frame);
    target.style.removeProperty(KEYBOARD_INSET_VAR);
  };
}

/** Wires `watchKeyboardInset` to an element while `enabled`; nothing runs on the server. */
export function useKeyboardInset(ref: RefObject<HTMLElement | null>, enabled = true): void {
  useEffect(() => {
    const element = ref.current;
    if (!enabled || !element || typeof window === "undefined") return;
    return watchKeyboardInset(element, window);
  }, [ref, enabled]);
}
