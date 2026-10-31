import { describe, expect, it } from "vitest";
import { KEYBOARD_INSET_VAR, watchKeyboardInset, type InsetViewport, type InsetWindow } from "./use-keyboard-inset";

/** A fake phone: a visual viewport that fires events, frames run on demand. */
function phone(withViewport = true) {
  const listeners = new Map<string, Set<() => void>>();
  const viewport = {
    height: 844,
    offsetTop: 0,
    scale: 1,
    addEventListener: (type: string, fn: () => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)?.add(fn);
    },
    removeEventListener: (type: string, fn: () => void) => listeners.get(type)?.delete(fn),
  } satisfies InsetViewport;
  const frames = new Map<number, () => void>();
  let nextHandle = 1;
  const win: InsetWindow = {
    innerHeight: 844,
    visualViewport: withViewport ? viewport : undefined,
    requestAnimationFrame: (fn) => {
      const handle = nextHandle++;
      frames.set(handle, fn);
      return handle;
    },
    cancelAnimationFrame: (handle) => frames.delete(handle),
  };
  const style = new Map<string, string>();
  const target = {
    style: {
      setProperty: (name: string, value: string) => style.set(name, value),
      removeProperty: (name: string) => style.delete(name),
    },
  };
  return {
    viewport,
    win,
    target,
    style,
    frames,
    fire: (type: string) => listeners.get(type)?.forEach((fn) => fn()),
    listenerCount: () => [...listeners.values()].reduce((n, set) => n + set.size, 0),
    runFrames: () => {
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach((fn) => fn());
    },
  };
}

describe("watchKeyboardInset wiring (PIN-226)", () => {
  it("does nothing without visualViewport", () => {
    const p = phone(false);
    const stop = watchKeyboardInset(p.target, p.win);
    expect(p.frames.size).toBe(0);
    expect(p.style.size).toBe(0);
    stop();
    expect(p.style.size).toBe(0);
  });

  it("measures once on start: 0px with the keyboard closed", () => {
    const p = phone();
    watchKeyboardInset(p.target, p.win);
    expect(p.style.has(KEYBOARD_INSET_VAR)).toBe(false);
    p.runFrames();
    expect(p.style.get(KEYBOARD_INSET_VAR)).toBe("0px");
  });

  it("follows resize and scroll, one write per animation frame", () => {
    const p = phone();
    watchKeyboardInset(p.target, p.win);
    p.runFrames();
    p.viewport.height = 508;
    p.fire("resize");
    p.fire("resize");
    p.fire("scroll");
    expect(p.frames.size).toBe(1);
    p.runFrames();
    expect(p.style.get(KEYBOARD_INSET_VAR)).toBe("336px");
    p.viewport.offsetTop = 120;
    p.fire("scroll");
    p.runFrames();
    expect(p.style.get(KEYBOARD_INSET_VAR)).toBe("216px");
    p.viewport.scale = 2;
    p.fire("resize");
    p.runFrames();
    expect(p.style.get(KEYBOARD_INSET_VAR)).toBe("0px");
  });

  it("cleans up: listeners off, pending frame cancelled, variable removed", () => {
    const p = phone();
    const stop = watchKeyboardInset(p.target, p.win);
    p.runFrames();
    expect(p.listenerCount()).toBe(2);
    p.fire("resize");
    expect(p.frames.size).toBe(1);
    stop();
    expect(p.listenerCount()).toBe(0);
    expect(p.frames.size).toBe(0);
    expect(p.style.has(KEYBOARD_INSET_VAR)).toBe(false);
  });
});
