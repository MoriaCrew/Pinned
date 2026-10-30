/**
 * AI-call log store port (PIN-5, narrowed in PIN-93). The decorated
 * capability ports append one `AiCallLog` per provider call through
 * this interface and the daily guard reads them back by day bucket;
 * the game/player/submission surface went with the legacy routes
 * that were its only callers. This in-memory version is the test
 * double and the contract. (The `GameRepository` name predates the
 * Studio pivot and is kept to avoid a repo-wide rename.)
 */
import type { AiCallLog } from "./types";

export interface GameRepository {
  appendAiCallLog(log: AiCallLog): Promise<void>;
  listAiCallLogs(dayBucket: string): Promise<AiCallLog[]>;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class InMemoryGameRepository implements GameRepository {
  private aiLogs: AiCallLog[] = [];

  async appendAiCallLog(log: AiCallLog): Promise<void> {
    this.aiLogs.push(clone(log));
  }

  async listAiCallLogs(dayBucket: string): Promise<AiCallLog[]> {
    return this.aiLogs.filter((l) => l.dayBucket === dayBucket).map(clone);
  }
}
