import "server-only";
/**
 * Firestore StarterAllowanceStore (PIN-204): one doc per maker key
 * at `starterAllowances/{key}`, decided by the pure
 * decideStarterSlot inside one transaction, so instances share the
 * counter and concurrent claims for the last slot cannot both win.
 * The key is already hashed by the caller (never a raw IP or user
 * id). `expireAtTs` mirrors the state's `expireAt` as a Timestamp
 * so an operator TTL policy on it can drop stale counters (the
 * aiCallLogs pattern, docs/16). Direct doc reads only: no index.
 */
import { Firestore, Timestamp, type DocumentData } from "@google-cloud/firestore";
import {
  assertMakerKey,
  decideStarterSlot,
  type StarterAllowanceParams,
  type StarterAllowanceState,
  type StarterAllowanceStore,
} from "../domain/starter-allowance";

const STARTER_ALLOWANCES = "starterAllowances";

function fromData(data: DocumentData | undefined): StarterAllowanceState | null {
  if (!data) return null;
  const raw = { ...data };
  delete raw.expireAtTs;
  return raw as StarterAllowanceState;
}

function toData(state: StarterAllowanceState): DocumentData {
  return {
    ...(JSON.parse(JSON.stringify(state)) as DocumentData),
    expireAtTs: Timestamp.fromMillis(state.expireAt),
  };
}

export class FirestoreStarterAllowanceStore implements StarterAllowanceStore {
  constructor(private readonly db: Firestore) {}

  async tryClaim(key: string, now: number, params: StarterAllowanceParams): Promise<boolean> {
    assertMakerKey(key);
    const ref = this.db.collection(STARTER_ALLOWANCES).doc(key);
    return this.db.runTransaction(async (tx) => {
      const current = fromData((await tx.get(ref)).data());
      const decision = decideStarterSlot(key, current, now, params);
      if (!decision.allowed || decision.next === null) return false;
      tx.set(ref, toData(decision.next));
      return true;
    });
  }
}

export interface FirestoreStarterAllowanceStoreOptions {
  projectId?: string | null;
  emulatorHost?: string | null;
}

export function createFirestoreStarterAllowanceStore(
  options: FirestoreStarterAllowanceStoreOptions = {},
): FirestoreStarterAllowanceStore {
  const db = options.emulatorHost
    ? new Firestore({
        projectId: options.projectId ?? undefined,
        host: options.emulatorHost,
        ssl: false,
      })
    : new Firestore({ projectId: options.projectId ?? undefined });
  return new FirestoreStarterAllowanceStore(db);
}
