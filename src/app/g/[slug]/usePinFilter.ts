"use client";

import { useEffect, useRef, useState } from "react";
import type { PinCard } from "../../../domain/board-view";
import {
  advanceSeenAt,
  newestPinAt,
  parsePinFilter,
  pinFilterOptions,
  resolvePinFilter,
  serializePinFilter,
  type PinFilter,
  type PinFilterOption,
} from "../../../domain/pin-filter";

/** sessionStorage: the chip this tab last chose on this board. */
const filterKey = (slug: string) => `pinned.pinFilter:${slug}`;
/** localStorage: the newest pin time (server clock) seen on this board's last visit. */
const seenKey = (slug: string) => `pinned.pinsSeenAt:${slug}`;

function readSeen(slug: string): number | null {
  try {
    const raw = window.localStorage.getItem(seenKey(slug));
    const parsed = raw === null ? NaN : Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Moves the stored watermark forward only (see `advanceSeenAt`). */
function writeSeen(slug: string, newest: number | null) {
  const next = advanceSeenAt(readSeen(slug), newest);
  if (next === null) return;
  try {
    window.localStorage.setItem(seenKey(slug), String(next));
  } catch {
    // Private mode: no New chip next time, nothing else changes.
  }
}

function readChoice(slug: string): PinFilter {
  try {
    return parsePinFilter(window.sessionStorage.getItem(filterKey(slug)));
  } catch {
    return { kind: "all" };
  }
}

function writeChoice(slug: string, filter: PinFilter) {
  try {
    window.sessionStorage.setItem(filterKey(slug), serializePinFilter(filter));
  } catch {
    // Private mode: the choice lasts until reload.
  }
}

export interface PinFilterControls {
  /** The chips, in order; empty when nothing would narrow the grid (no row). */
  options: PinFilterOption[];
  /** The filter the grid shows (All when the chosen chip is gone). */
  active: PinFilter;
  onChange: (filter: PinFilter) => void;
}

/**
 * The board's pin filter (PIN-218). Storage is read once after mount
 * (the server render is always All, so hydration matches). "Last
 * visit" is the newest pin time seen, written whenever the page is
 * hidden or left; it is read once per visit, so New stays put while
 * you look at it and counts pins that land during the visit too.
 */
export function usePinFilter(slug: string, cards: readonly PinCard[], meId: string | null): PinFilterControls {
  const [chosen, setChosen] = useState<PinFilter>({ kind: "all" });
  const [lastSeenAt, setLastSeenAt] = useState<number | null>(null);
  const loadedFor = useRef<string | null>(null);
  useEffect(() => {
    if (loadedFor.current === slug) return;
    loadedFor.current = slug;
    setChosen(readChoice(slug));
    setLastSeenAt(readSeen(slug));
  }, [slug]);

  const newest = newestPinAt(cards);
  const newestRef = useRef(newest);
  useEffect(() => {
    newestRef.current = newest;
  }, [newest]);
  useEffect(() => {
    const save = () => writeSeen(slug, newestRef.current);
    const onVisibility = () => {
      if (document.visibilityState === "hidden") save();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", save);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", save);
      save();
    };
  }, [slug]);

  const options = pinFilterOptions(cards, meId, lastSeenAt);
  return {
    options,
    active: resolvePinFilter(chosen, options),
    onChange: (filter) => {
      setChosen(filter);
      writeChoice(slug, filter);
    },
  };
}
