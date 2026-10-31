import "server-only";
import type { DocumentData } from "@google-cloud/firestore";

/**
 * Plain JSON copy for Firestore writes: drops `undefined` fields
 * (Firestore rejects them) and detaches the stored data from the
 * caller's object. Shared by every `firestore-*` store.
 */
export function toFirestoreData<T extends object>(value: T): DocumentData {
  return JSON.parse(JSON.stringify(value)) as DocumentData;
}
