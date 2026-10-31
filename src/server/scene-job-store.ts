import "server-only";
/**
 * Server SceneJobStore selection (PIN-69), mirroring
 * ./decompose-job-store.ts: Firestore in hosted environments,
 * in-memory as the deterministic local/test fallback.
 */
import { getConfig, type AppConfig } from "../config";
import { createFirestoreSceneJobStore } from "./firestore-scene-job-store";
import {
  InMemorySceneJobStore,
  type SceneJobStore,
} from "./scene-job";

export function createSceneJobStore(
  config: AppConfig = getConfig(),
): SceneJobStore {
  if (config.dataBackend === "firestore") {
    return createFirestoreSceneJobStore({
      projectId: config.firebaseProjectId,
      emulatorHost: config.firestoreEmulatorHost,
    });
  }
  return new InMemorySceneJobStore();
}

const globalStore = globalThis as typeof globalThis & {
  __pinnedSceneJobStore?: SceneJobStore;
};

/** Process-wide store; also makes the memory fallback coherent in dev. */
export function getSceneJobStore(): SceneJobStore {
  globalStore.__pinnedSceneJobStore ??= createSceneJobStore();
  return globalStore.__pinnedSceneJobStore;
}
