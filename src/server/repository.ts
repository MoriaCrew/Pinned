/**
 * Server repository selection (PIN-29). Persistence is explicit:
 * DATA_BACKEND=firestore in hosted environments; memory remains the
 * deterministic local/test fallback and is never selected silently
 * when Firestore is requested.
 */
import { getConfig, type AppConfig } from "../config";
import { InMemoryGameRepository, type GameRepository } from "../domain/repository";
import { createFirestoreGameRepository } from "./firestore-repository";

export function createGameRepository(config: AppConfig = getConfig()): GameRepository {
  if (config.dataBackend === "firestore") {
    return createFirestoreGameRepository({
      projectId: config.firebaseProjectId,
      emulatorHost: config.firestoreEmulatorHost,
    });
  }
  return new InMemoryGameRepository();
}

const globalRepository = globalThis as typeof globalThis & {
  __pinnedGameRepository?: GameRepository;
};

/** Process-wide repository; also makes the memory fallback coherent in dev. */
export function getGameRepository(): GameRepository {
  globalRepository.__pinnedGameRepository ??= createGameRepository();
  return globalRepository.__pinnedGameRepository;
}
