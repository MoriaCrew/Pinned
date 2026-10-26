import { describe, expect, it } from "vitest";
import { parseConfig } from "../config";
import { InMemoryGameRepository } from "../domain/repository";
import { createGameRepository } from "./repository";
import { FirestoreGameRepository } from "./firestore-repository";

describe("createGameRepository", () => {
  it("uses memory by default", () => {
    expect(createGameRepository(parseConfig({}))).toBeInstanceOf(InMemoryGameRepository);
  });

  it("constructs Firestore only when explicitly requested", async () => {
    const repo = createGameRepository(
      parseConfig({
        DATA_BACKEND: "firestore",
        FIREBASE_PROJECT_ID: "pinned-test",
        FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080",
      }),
    );
    expect(repo).toBeInstanceOf(FirestoreGameRepository);
    await (repo as FirestoreGameRepository).close();
  });
});
