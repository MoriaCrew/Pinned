/**
 * GameRepository port (PIN-5). Firestore implementation arrives
 * with the data-layer issue; this in-memory version is the test
 * double and the contract.
 */
import type { AiCallLog, Game, GameChain, GameState, Player, Submission } from "./types";

export interface RecordSubmissionResult {
  /** Previous active entries of this player, now superseded. */
  superseded: Submission[];
  entryCount: number;
}

export interface RecordSubmissionGuard {
  now: number;
  maxSubmissionsPerPlayer: number;
  maxSubmissionsPerGame: number;
  minIntervalMs: number;
}

export type SubmissionRejection = "game_closed" | "player_cap" | "game_cap" | "too_fast";

export class SubmissionRejectedError extends Error {
  constructor(public readonly code: SubmissionRejection) {
    super(`Submission rejected: ${code}`);
    this.name = "SubmissionRejectedError";
  }
}

/** Shared transactional guard so both repositories enforce identically. */
export function assertSubmissionAllowed(
  game: { state: GameState; deadlineAt: number },
  existing: readonly Submission[],
  submission: Submission,
  guard: RecordSubmissionGuard,
): void {
  if (game.state !== "OPEN" || guard.now >= game.deadlineAt) {
    throw new SubmissionRejectedError("game_closed");
  }
  const mine = existing.filter((entry) => entry.playerId === submission.playerId);
  if (mine.length >= guard.maxSubmissionsPerPlayer) throw new SubmissionRejectedError("player_cap");
  if (existing.length >= guard.maxSubmissionsPerGame) throw new SubmissionRejectedError("game_cap");
  const lastAt = mine.reduce((max, entry) => Math.max(max, entry.submittedAt), 0);
  if (lastAt && guard.now - lastAt < guard.minIntervalMs) throw new SubmissionRejectedError("too_fast");
}

export interface GameRepository {
  createChain(chain: GameChain): Promise<void>;
  getChain(chainId: string): Promise<GameChain | null>;
  createGame(game: Game): Promise<void>;
  getGame(slug: string): Promise<Game | null>;
  putPlayer(player: Player): Promise<void>;
  getPlayer(gameId: string, playerId: string): Promise<Player | null>;
  listPlayers(gameId: string): Promise<Player[]>;
  /**
   * Atomically record a player's new active entry (PIN-35): store
   * the submission, supersede every other active entry of that
   * player, and refresh Game.entryCount from the post-write set —
   * one unit, so concurrent submits can neither leave two actives
   * nor lose entries from the count.
   */
  recordSubmission(
    submission: Submission,
    supersededAt: number,
    guard?: RecordSubmissionGuard,
  ): Promise<RecordSubmissionResult>;
  putSubmission(submission: Submission): Promise<void>;
  listSubmissions(gameId: string): Promise<Submission[]>;
  appendAiCallLog(log: AiCallLog): Promise<void>;
  listAiCallLogs(dayBucket: string): Promise<AiCallLog[]>;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class InMemoryGameRepository implements GameRepository {
  private chains = new Map<string, GameChain>();
  private games = new Map<string, Game>();
  private players = new Map<string, Player>();
  private submissions = new Map<string, Submission>();
  private aiLogs: AiCallLog[] = [];

  async createChain(chain: GameChain): Promise<void> {
    if (this.chains.has(chain.id)) throw new RangeError(`Chain ${chain.id} already exists`);
    this.chains.set(chain.id, clone(chain));
  }

  async getChain(chainId: string): Promise<GameChain | null> {
    const chain = this.chains.get(chainId);
    return chain ? clone(chain) : null;
  }

  async createGame(game: Game): Promise<void> {
    if (this.games.has(game.id)) throw new RangeError(`Game ${game.id} already exists`);
    this.games.set(game.id, clone(game));
  }

  async getGame(slug: string): Promise<Game | null> {
    const game = this.games.get(slug);
    return game ? clone(game) : null;
  }

  async putPlayer(player: Player): Promise<void> {
    this.players.set(`${player.gameId}/${player.id}`, clone(player));
  }

  async getPlayer(gameId: string, playerId: string): Promise<Player | null> {
    const player = this.players.get(`${gameId}/${playerId}`);
    return player ? clone(player) : null;
  }

  async listPlayers(gameId: string): Promise<Player[]> {
    return [...this.players.values()].filter((p) => p.gameId === gameId).map(clone);
  }

  // No awaits between reads and writes: the body runs to completion
  // synchronously, which is what makes this atomic in-process.
  async recordSubmission(
    submission: Submission,
    supersededAt: number,
    guard?: RecordSubmissionGuard,
  ): Promise<RecordSubmissionResult> {
    const game = this.games.get(submission.gameId);
    if (!game) throw new RangeError(`Game ${submission.gameId} not found`);
    if (guard) {
      assertSubmissionAllowed(game, [...this.submissions.values()].filter((s) => s.gameId === submission.gameId), submission, guard);
    }
    const superseded: Submission[] = [];
    for (const existing of this.submissions.values()) {
      if (
        existing.gameId === submission.gameId &&
        existing.playerId === submission.playerId &&
        existing.id !== submission.id &&
        existing.status === "active"
      ) {
        const replaced: Submission = {
          ...clone(existing),
          status: "superseded",
          supersededAt,
          version: existing.version + 1,
        };
        this.submissions.set(`${replaced.gameId}/${replaced.id}`, replaced);
        superseded.push(clone(replaced));
      }
    }
    this.submissions.set(`${submission.gameId}/${submission.id}`, clone(submission));
    const activePlayers = new Set<string>();
    for (const entry of this.submissions.values()) {
      if (entry.gameId === submission.gameId && entry.status === "active") {
        activePlayers.add(entry.playerId);
      }
    }
    const entryCount = activePlayers.size;
    this.games.set(submission.gameId, { ...clone(game), entryCount });
    return { superseded, entryCount };
  }

  async putSubmission(submission: Submission): Promise<void> {
    this.submissions.set(`${submission.gameId}/${submission.id}`, clone(submission));
  }

  async listSubmissions(gameId: string): Promise<Submission[]> {
    return [...this.submissions.values()].filter((s) => s.gameId === gameId).map(clone);
  }

  async appendAiCallLog(log: AiCallLog): Promise<void> {
    this.aiLogs.push(clone(log));
  }

  async listAiCallLogs(dayBucket: string): Promise<AiCallLog[]> {
    return this.aiLogs.filter((l) => l.dayBucket === dayBucket).map(clone);
  }
}
