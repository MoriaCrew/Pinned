import type { Catalog, Lock } from "./core.mjs";

export const ROOT: string;
export const MESSAGES_DIR: string;
export const GLOSSARY_PATH: string;
export function listLocales(dir?: string): string[];
export function loadEnglish(dir?: string): Catalog;
export function loadLocale(locale: string, dir?: string): Catalog;
export function loadLock(locale: string, dir?: string): Lock;
export function loadGlossary(): { doNotTranslate: string[]; concepts?: string[]; terms: Record<string, Record<string, string>> };
export function writeJson(file: string, value: unknown): void;
export function loadSources(root?: string): { path: string; text: string }[];
export function runCatalogCheck(opts?: { dir?: string; root?: string }): {
  englishKeys: number;
  locales: Record<string, { errors: string[]; missing: string[] }>;
  unused: string[];
  testOnly: string[];
};
