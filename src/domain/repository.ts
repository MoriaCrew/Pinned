/**
 * GameRepository port (PIN-5). Firestore implementation arrives
 * with the data-layer issue; this in-memory version is the test
 * double and the contract. CAS encodes the deadline vs
 * force-close race: first writer wins, the loser sees the same
 * target state and gets { changed: false }, not an error.
 */
import { transitionGame, type GameState, type TransitionResult } from "./game-state";
import type { AiCallLog, Game, GameChain, Player, Submission } from "./types";

export class VersionConflictError extends Error {
  constructor(
    public readonly expectedVersion: number,
    public readonly actualVersion: number,
  ) {
    super(`Game version conflict: expected ${expectedVersion}, found ${actualVersion}`);
    this.name = "VersionConflictError";
  }
}

export interface GameRepository {
  createChain(chain: GameChain): Promise<void>;
  getChain(chainId: string): Promise<GameChain | null>;
  createGame(game: Game): Promise<void>;
  getGame(slug: string): Promise<Game | null>;
  /** Optimistic transition; same-target no-op returns changed:false. */
  compareAndSetGameState(
    slug: string,
    expectedVersion: number,
    to: GameState,
    now: number,
  ): Promise<TransitionResult>;
  putPlayer(player: Player): Promise<void>;
  getPlayer(gameId: string, playerId: string): Promise<Player | null>;
  listPlayers(gameId: string): Promise<Player[]>;
  /**
   * Refresh the derived active-entry count (PIN-35). Display data
   * only: deliberately does not bump the state-transition version.
   */
  setEntryCount(slug: string, entryCount: number): Promise<void>;
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

  async compareAndSetGameState(
    slug: string,
    expectedVersion: number,
    to: GameState,
    now: number,
  ): Promise<TransitionResult> {
    const current = this.games.get(slug);
    if (!current) throw new RangeError(`Game ${slug} not found`);
    // Race loser: someone else already moved to the target state.
    if (current.state === to) return { game: clone(current), changed: false };
    if (current.version !== expectedVersion) {
      throw new VersionConflictError(expectedVersion, current.version);
    }
    const result = transitionGame(current, to, now);
    this.games.set(slug, clone(result.game));
    return { game: clone(result.game), changed: result.changed };
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

  async setEntryCount(slug: string, entryCount: number): Promise<void> {
    const game = this.games.get(slug);
    if (!game) throw new RangeError(`Game ${slug} not found`);
    this.games.set(slug, { ...clone(game), entryCount });
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
