import type { z } from "zod";

export type Catalog = Record<string, string>;
export type Lock = { prompt?: string; keys: Record<string, string> } | null;

export function placeholders(text: string): string[];
export function pluralPartner(key: string): string | null;
export function entryHash(english: string, promptVersion: string): string;
export function normalizeTranslation(text: string): string;
export function deltaKeys(args: {
  en: Catalog;
  locale: Catalog;
  lock: Lock;
  promptVersion: string;
  force?: boolean;
  only?: string[] | null;
}): string[];
export function batchKeys(keys: string[], size: number): string[][];
export function parseModelJson<T = Catalog>(reply: unknown, schema?: z.ZodType<T>): T;
export const ReviewSchema: z.ZodType<{ corrections: { key: string; value: string; reason: string }[] }>;
export type CheckOptions = { doNotTranslate?: string[]; maxRatio?: number };
export function checkEntry(english: string, translated: unknown, opts?: CheckOptions): { errors: string[]; warnings: string[] };
export function validateBatch(
  requested: Catalog,
  result: Catalog,
  opts?: CheckOptions,
): { ok: Catalog; failed: Record<string, string>; warnings: Record<string, string[]>; extra: string[] };
export function orderLikeEnglish(en: Catalog, entries: Catalog): Catalog;
export function checkCatalog(en: Catalog, locale: Record<string, unknown>): { errors: string[]; missing: string[] };
export function findUnusedKeys(
  enKeys: string[],
  sources: { path: string; text: string }[],
): { unused: string[]; testOnly: string[] };
