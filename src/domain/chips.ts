/**
 * Generated suggestion chips: pure label-set + cache-entry logic
 * (PIN-75, docs/11 Q10). The cache key is the sorted, lowercased
 * label set (hashed by the server store), so the same picks in any
 * order or case share one entry across boards. The fixed Policy
 * list stays the instant fallback whenever generation is missing,
 * refused, failed or over budget.
 */

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

export interface ChipsCacheEntry {
  /** chipsCacheKeyBase of the label set (sorted lowercased labels). */
  key: string;
  chips: string[];
  /** Policy promptVersions.chips that produced the chips. */
  promptVersion: string;
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
