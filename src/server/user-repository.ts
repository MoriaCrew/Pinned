import "server-only";
/**
 * Server UserRepository selection (PIN-83), mirroring
 * ./board-repository.ts: DATA_BACKEND=firestore in hosted
 * environments; memory stays the deterministic local/test
 * fallback and is never selected silently when Firestore is
 * requested.
 */
import { getConfig, type AppConfig } from "../config";
import {
  InMemoryUserRepository,
  type UserRepository,
} from "../domain/user-repository";
import { createFirestoreUserRepository } from "./firestore-user-repository";

export function createUserRepository(config: AppConfig = getConfig()): UserRepository {
  if (config.dataBackend === "firestore") {
    return createFirestoreUserRepository({
      projectId: config.firebaseProjectId,
      emulatorHost: config.firestoreEmulatorHost,
    });
  }
  return new InMemoryUserRepository();
}

const globalRepository = globalThis as typeof globalThis & {
  __pinnedUserRepository?: UserRepository;
};

/** Process-wide repository; also makes the memory fallback coherent in dev. */
export function getUserRepository(): UserRepository {
  globalRepository.__pinnedUserRepository ??= createUserRepository();
  return globalRepository.__pinnedUserRepository;
}
