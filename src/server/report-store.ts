import "server-only";
/**
 * ReportStore selection (PIN-269), mirroring ./starter-allowance-store.ts:
 * Firestore in hosted environments, the in-memory contract store for
 * the memory backend.
 */
import { getConfig, type AppConfig } from "../config";
import { InMemoryReportStore, type ReportStore } from "../domain/report-store";
import { createFirestoreReportStore } from "./firestore-report-store";

export function createReportStore(config: AppConfig = getConfig()): ReportStore {
  if (config.dataBackend === "firestore") {
    return createFirestoreReportStore({
      projectId: config.firebaseProjectId,
      emulatorHost: config.firestoreEmulatorHost,
    });
  }
  return new InMemoryReportStore();
}

const globalReports = globalThis as typeof globalThis & {
  __pinnedReportStore?: ReportStore;
};

/** Process-wide store so the memory fallback stays coherent in dev. */
export function getReportStore(): ReportStore {
  globalReports.__pinnedReportStore ??= createReportStore();
  return globalReports.__pinnedReportStore;
}
