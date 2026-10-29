import { describe, expect, it } from "vitest";
import { parseConfig } from "../config";
import { InMemoryBoardRepository } from "../domain/board-repository";
import { createBoardRepository } from "./board-repository";
import { FirestoreBoardRepository } from "./firestore-board-repository";

describe("createBoardRepository", () => {
  it("uses memory by default", () => {
    expect(createBoardRepository(parseConfig({}))).toBeInstanceOf(InMemoryBoardRepository);
  });

  it("constructs Firestore only when explicitly requested", async () => {
    const repo = createBoardRepository(
      parseConfig({
        DATA_BACKEND: "firestore",
        FIREBASE_PROJECT_ID: "pinned-test",
        FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080",
      }),
    );
    expect(repo).toBeInstanceOf(FirestoreBoardRepository);
    await (repo as FirestoreBoardRepository).close();
  });
});
