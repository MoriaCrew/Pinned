/**
 * Firestore GameRepository (PIN-29). Server-only: client Firestore
 * access remains deny-all in firestore.rules.
 *
 * Layout:
 * - chains/{chainId}
 * - games/{slug}; players and submissions are subcollections
 * - aiCallLogs/{logId}
 *
 * All domain times stay epoch-ms numbers. Writes strip undefined
 * recursively because Firestore rejects undefined field values.
 */
import { Firestore, type DocumentData, type DocumentSnapshot } from "@google-cloud/firestore";
import {
  VersionConflictError,
  type GameRepository,
  assertSubmissionAllowed,
  type RecordSubmissionGuard,
} from "../domain/repository";
import { transitionGame, type GameState, type TransitionResult } from "../domain/game-state";
import type { AiCallLog, Game, GameChain, Player, Submission } from "../domain/types";

const CHAINS = "chains";
const GAMES = "games";
const PLAYERS = "players";
const SUBMISSIONS = "submissions";
const AI_CALL_LOGS = "aiCallLogs";

function toFirestoreData<T extends object>(value: T): DocumentData {
  return JSON.parse(JSON.stringify(value)) as DocumentData;
}

function fromSnapshot<T>(snapshot: DocumentSnapshot): T | null {
  if (!snapshot.exists) return null;
  return structuredClone(snapshot.data() as T);
}

function isAlreadyExists(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; message?: unknown };
  return candidate.code === 6 ||
    candidate.code === "already-exists" ||
    (typeof candidate.message === "string" && /already exists/i.test(candidate.message));
}

async function createOrThrow(
  create: () => Promise<unknown>,
  label: string,
): Promise<void> {
  try {
    await create();
  } catch (error) {
    if (isAlreadyExists(error)) throw new RangeError(`${label} already exists`);
    throw error;
  }
}

export class FirestoreGameRepository implements GameRepository {
  constructor(private readonly db: Firestore) {}

  private chainRef(chainId: string) {
    return this.db.collection(CHAINS).doc(chainId);
  }

  private gameRef(slug: string) {
    return this.db.collection(GAMES).doc(slug);
  }

  async createChain(chain: GameChain): Promise<void> {
    await createOrThrow(
      () => this.chainRef(chain.id).create(toFirestoreData(chain)),
      `Chain ${chain.id}`,
    );
  }

  async getChain(chainId: string): Promise<GameChain | null> {
    return fromSnapshot<GameChain>(await this.chainRef(chainId).get());
  }

  async createGame(game: Game): Promise<void> {
    await createOrThrow(
      () => this.gameRef(game.id).create(toFirestoreData(game)),
      `Game ${game.id}`,
    );
  }

  async getGame(slug: string): Promise<Game | null> {
    return fromSnapshot<Game>(await this.gameRef(slug).get());
  }

  async compareAndSetGameState(
    slug: string,
    expectedVersion: number,
    to: GameState,
    now: number,
  ): Promise<TransitionResult> {
    const ref = this.gameRef(slug);
    return this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      const current = fromSnapshot<Game>(snapshot);
      if (!current) throw new RangeError(`Game ${slug} not found`);
      if (current.state === to) return { game: current, changed: false };
      if (current.version !== expectedVersion) {
        throw new VersionConflictError(expectedVersion, current.version);
      }
      const result = transitionGame(current, to, now);
      transaction.set(ref, toFirestoreData(result.game));
      return result;
    });
  }

  private playerRef(gameId: string, playerId: string) {
    return this.gameRef(gameId).collection(PLAYERS).doc(playerId);
  }

  async putPlayer(player: Player): Promise<void> {
    await this.playerRef(player.gameId, player.id).set(toFirestoreData(player));
  }

  async getPlayer(gameId: string, playerId: string): Promise<Player | null> {
    return fromSnapshot<Player>(await this.playerRef(gameId, playerId).get());
  }

  async listPlayers(gameId: string): Promise<Player[]> {
    const snapshot = await this.gameRef(gameId).collection(PLAYERS).get();
    return snapshot.docs.map((doc) => structuredClone(doc.data() as Player));
  }

  async recordSubmission(submission: Submission, supersededAt: number, guard?: RecordSubmissionGuard) {
    const gameRef = this.gameRef(submission.gameId);
    const submissionsRef = gameRef.collection(SUBMISSIONS);
    return this.db.runTransaction(async (transaction) => {
      const game = fromSnapshot<Game>(await transaction.get(gameRef));
      if (!game) throw new RangeError(`Game ${submission.gameId} not found`);
      const snapshot = await transaction.get(submissionsRef);
      const existing = snapshot.docs.map(
        (doc) => structuredClone(doc.data() as Submission),
      );
      if (guard) assertSubmissionAllowed(game, existing, submission, guard);
      const superseded = existing
        .filter(
          (entry) =>
            entry.playerId === submission.playerId &&
            entry.id !== submission.id &&
            entry.status === "active",
        )
        .map((entry) => ({
          ...entry,
          status: "superseded" as const,
          supersededAt,
          version: entry.version + 1,
        }));
      transaction.set(
        submissionsRef.doc(submission.id),
        toFirestoreData(submission),
      );
      for (const replaced of superseded) {
        transaction.set(submissionsRef.doc(replaced.id), toFirestoreData(replaced));
      }
      const supersededIds = new Set(superseded.map((entry) => entry.id));
      const activePlayers = new Set(
        existing
          .filter((entry) => entry.status === "active" && !supersededIds.has(entry.id))
          .map((entry) => entry.playerId),
      );
      activePlayers.add(submission.playerId);
      const entryCount = activePlayers.size;
      if (entryCount !== game.entryCount) {
        transaction.set(gameRef, toFirestoreData({ ...game, entryCount }));
      }
      return { superseded, entryCount };
    });
  }

  async putSubmission(submission: Submission): Promise<void> {
    await this.gameRef(submission.gameId)
      .collection(SUBMISSIONS)
      .doc(submission.id)
      .set(toFirestoreData(submission));
  }

  async listSubmissions(gameId: string): Promise<Submission[]> {
    const snapshot = await this.gameRef(gameId).collection(SUBMISSIONS).get();
    return snapshot.docs.map((doc) => structuredClone(doc.data() as Submission));
  }

  async appendAiCallLog(log: AiCallLog): Promise<void> {
    await this.db.collection(AI_CALL_LOGS).doc(log.id).set(toFirestoreData(log));
  }

  async listAiCallLogs(dayBucket: string): Promise<AiCallLog[]> {
    const snapshot = await this.db
      .collection(AI_CALL_LOGS)
      .where("dayBucket", "==", dayBucket)
      .get();
    return snapshot.docs.map((doc) => structuredClone(doc.data() as AiCallLog));
  }

  /** Release the underlying gRPC client in scripts and tests. */
  async close(): Promise<void> {
    await this.db.terminate();
  }
}

export interface FirestoreRepositoryOptions {
  projectId?: string | null;
  emulatorHost?: string | null;
}

export function createFirestoreGameRepository(
  options: FirestoreRepositoryOptions = {},
): FirestoreGameRepository {
  const db = options.emulatorHost
    ? new Firestore({
        projectId: options.projectId ?? undefined,
        host: options.emulatorHost,
        ssl: false,
      })
    : new Firestore({ projectId: options.projectId ?? undefined });
  return new FirestoreGameRepository(db);
}
