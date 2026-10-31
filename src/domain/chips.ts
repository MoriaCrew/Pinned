/**
 * Generated suggestion chips: pure label-set + cache-entry logic
 * (PIN-75, docs/11 Q10). The cache key is the prompt version, the
 * viewer's language and the sorted, lowercased label set (hashed by
 * the server store), so the same picks in any order or case share
 * one entry across boards, per language (PIN-214). The fixed idea
 * chips, in the viewer's language, stay the instant fallback
 * whenever generation is missing, refused, failed or over budget.
 */
import { t, type Locale, type MessageKey } from "../i18n";

/**
 * The fixed idea chips' catalog keys, in display order (PIN-214).
 * English lives in en.json; the other languages come from the
 * translate run and fall back to English until then.
 */
export const FIXED_CHIP_KEYS = [
  "make.chip.picnic",
  "make.chip.museum",
  "make.chip.space",
  "make.chip.party",
] as const satisfies readonly MessageKey[];

/** The first `count` (Policy.sceneChipsCount) fixed idea chips, in `locale`. */
export function fixedSceneChips(locale: Locale, count: number): string[] {
  return FIXED_CHIP_KEYS.slice(0, Math.max(0, count)).map((key) => t(locale, key));
}

/** Canonical label form: trimmed, whitespace-collapsed, lowercased. */
export function normalizeChipLabel(label: string): string {
  return label.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Sorted unique normalized labels — the cache identity of a pick set. */
export function normalizeChipLabels(labels: readonly string[]): string[] {
  return [...new Set(labels.map(normalizeChipLabel).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b),
  );
}

/**
 * Canonical cache-key material for a label set. The separator
 * cannot appear inside a normalized label (labels are one line),
 * so distinct sets never collide before hashing.
 */
export function chipsCacheKeyBase(labels: readonly string[]): string {
  return normalizeChipLabels(labels).join("\n");
}

/** What a cached chip set depends on besides its labels (PIN-214). */
export interface ChipsCacheScope {
  /** The request's UI language: the chips are written in it. */
  locale: Locale;
  /** Policy promptVersions.chips: a new prompt never serves old chips. */
  promptVersion: string;
}

/**
 * Full cache identity (PIN-214): prompt version, language, then the
 * label set, one per line. The two header lines come first and are
 * one line each, so a label can never pose as them. Empty when no
 * label survives normalization (nothing to cache).
 */
export function chipsCacheKey(labels: readonly string[], scope: ChipsCacheScope): string {
  const labelSet = chipsCacheKeyBase(labels);
  if (!labelSet) return "";
  const version = scope.promptVersion.replace(/\s+/g, " ").trim();
  return [version, scope.locale, labelSet].join("\n");
}

export interface ChipsCacheEntry {
  /** chipsCacheKey: prompt version, language and label set. */
  key: string;
  chips: string[];
  /** Policy promptVersions.chips that produced the chips. */
  promptVersion: string;
  /** The language the chips are written in (PIN-214). */
  locale: Locale;
  createdAt: number;
}

/** Fresh while younger than Policy.chipsCacheTtlHours. */
export function isChipsCacheFresh(
  entry: Pick<ChipsCacheEntry, "createdAt">,
  now: number,
  ttlHours: number,
): boolean {
  return now - entry.createdAt < ttlHours * 60 * 60 * 1000;
}
