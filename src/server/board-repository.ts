import "server-only";
/**
 * Server BoardRepository selection (PIN-63), mirroring
 * ./repository.ts: DATA_BACKEND=firestore in hosted environments;
 * memory stays the deterministic local/test fallback and is never
 * selected silently when Firestore is requested.
 */
import { getConfig, type AppConfig } from "../config";
import {
  InMemoryBoardRepository,
  type BoardRepository,
} from "../domain/board-repository";
import { createFirestoreBoardRepository } from "./firestore-board-repository";

export function createBoardRepository(config: AppConfig = getConfig()): BoardRepository {
  if (config.dataBackend === "firestore") {
    return createFirestoreBoardRepository({
      projectId: config.firebaseProjectId,
      emulatorHost: config.firestoreEmulatorHost,
    });
  }
  return new InMemoryBoardRepository();
}

const globalRepository = globalThis as typeof globalThis & {
  __pinnedBoardRepository?: BoardRepository;
};

/** Process-wide repository; also makes the memory fallback coherent in dev. */
export function getBoardRepository(): BoardRepository {
  globalRepository.__pinnedBoardRepository ??= createBoardRepository();
  return globalRepository.__pinnedBoardRepository;
}
