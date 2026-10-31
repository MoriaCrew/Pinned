import "server-only";
/**
 * Firestore ChipsCacheStore (PIN-75): one doc per prompt version,
 * language and label set at aiCache/{sha256(chipsCacheKey)} —
 * direct doc get/set only, so no index or collection query exists.
 * Client rules stay deny-all; the Admin SDK server path owns this
 * collection. chips.v1 docs (no language) are never addressed again
 * since PIN-214 and read as a miss if they were.
 */
import { Firestore, type DocumentData } from "@google-cloud/firestore";
import type { ChipsCacheEntry } from "../domain/chips";
import { isLocale } from "../i18n/locales";
import { chipsCacheDocId, type ChipsCacheStore } from "./chips-cache";

const AI_CACHE = "aiCache";

function entryFrom(keyBase: string, data: DocumentData | undefined): ChipsCacheEntry | null {
  if (!data) return null;
  // Hash-collision / tamper guard: the doc must carry its own key.
  if (data.key !== keyBase) return null;
  if (!Array.isArray(data.chips) || data.chips.some((c) => typeof c !== "string")) return null;
  if (typeof data.promptVersion !== "string" || typeof data.createdAt !== "number") return null;
  if (!isLocale(data.locale)) return null;
  return {
    key: keyBase,
    chips: data.chips as string[],
    promptVersion: data.promptVersion,
    locale: data.locale,
    createdAt: data.createdAt,
  };
}

export class FirestoreChipsCacheStore implements ChipsCacheStore {
  constructor(private readonly db: Firestore) {}

  async get(keyBase: string): Promise<ChipsCacheEntry | null> {
    const snapshot = await this.db
      .collection(AI_CACHE)
      .doc(chipsCacheDocId(keyBase))
      .get();
    return entryFrom(keyBase, snapshot.exists ? snapshot.data() : undefined);
  }

  async put(entry: ChipsCacheEntry): Promise<void> {
    await this.db.collection(AI_CACHE).doc(chipsCacheDocId(entry.key)).set({
      key: entry.key,
      chips: entry.chips,
      promptVersion: entry.promptVersion,
      locale: entry.locale,
      createdAt: entry.createdAt,
    });
  }
}

export interface FirestoreChipsCacheOptions {
  projectId?: string | null;
  emulatorHost?: string | null;
}

export function createFirestoreChipsCacheStore(
  options: FirestoreChipsCacheOptions = {},
): FirestoreChipsCacheStore {
  const db = options.emulatorHost
    ? new Firestore({
        projectId: options.projectId ?? undefined,
        host: options.emulatorHost,
        ssl: false,
      })
    : new Firestore({ projectId: options.projectId ?? undefined });
  return new FirestoreChipsCacheStore(db);
}
