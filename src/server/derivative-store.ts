import "server-only";
/**
 * Ephemeral derivative storage (PIN-34 / PIN-7B).
 *
 * Only processed derivatives (never original uploads) are written,
 * always under the `tmp/` prefix so a single bucket lifecycle rule
 * can expire everything (see docs/06-photo-intake.md). Server-side
 * only: clients never read or write storage directly.
 */
import { Storage } from "@google-cloud/storage";
import { getConfig } from "../config";

export interface DerivativeStore {
  put(ref: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(ref: string): Promise<Buffer | null>;
  delete(ref: string): Promise<void>;
}

const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export function assertDerivativeRef(ref: string): string {
  if (
    !ref ||
    ref.length > 512 ||
    !REF_PATTERN.test(ref) ||
    ref.includes("..") ||
    ref.startsWith("/") ||
    ref.includes("//")
  ) {
    throw new Error("Invalid derivative reference.");
  }
  return ref;
}

/** Working-image ref for one submission attempt. */
export function buildWorkingImageRef(
  gameId: string,
  playerId: string,
  submissionId: string,
): string {
  return assertDerivativeRef(
    `tmp/games/${gameId}/players/${playerId}/submissions/${submissionId}/working.webp`,
  );
}

export class InMemoryDerivativeStore implements DerivativeStore {
  private readonly objects = new Map<string, { bytes: Buffer; contentType: string }>();

  async put(ref: string, bytes: Uint8Array, contentType: string): Promise<void> {
    this.objects.set(assertDerivativeRef(ref), {
      bytes: Buffer.from(bytes),
      contentType,
    });
  }

  async get(ref: string): Promise<Buffer | null> {
    const hit = this.objects.get(assertDerivativeRef(ref));
    return hit ? Buffer.from(hit.bytes) : null;
  }

  async delete(ref: string): Promise<void> {
    this.objects.delete(assertDerivativeRef(ref));
  }
}

export class GcsDerivativeStore implements DerivativeStore {
  private readonly storage: Storage;

  constructor(
    private readonly bucketName: string,
    projectId?: string | null,
  ) {
    this.storage = new Storage(projectId ? { projectId } : undefined);
  }

  private file(ref: string) {
    return this.storage.bucket(this.bucketName).file(assertDerivativeRef(ref));
  }

  async put(ref: string, bytes: Uint8Array, contentType: string): Promise<void> {
    await this.file(ref).save(Buffer.from(bytes), {
      contentType,
      resumable: false,
      metadata: { cacheControl: "private, max-age=0" },
    });
  }

  async get(ref: string): Promise<Buffer | null> {
    try {
      const [data] = await this.file(ref).download();
      return data;
    } catch (error) {
      if ((error as { code?: number }).code === 404) return null;
      throw error;
    }
  }

  async delete(ref: string): Promise<void> {
    try {
      await this.file(ref).delete();
    } catch (error) {
      if ((error as { code?: number }).code === 404) return;
      throw error;
    }
  }
}

const globalStore = globalThis as typeof globalThis & {
  __pinnedDerivativeStore?: DerivativeStore;
};

/**
 * Hosted (Firestore) environments use the Firebase default bucket via
 * ADC; local/memory environments stay in process so tests and the
 * demo need no cloud credentials.
 */
export function createDerivativeStore(): DerivativeStore {
  const config = getConfig();
  if (config.dataBackend === "firestore") {
    if (!config.storageBucket) {
      throw new Error("STORAGE_BUCKET is required when DATA_BACKEND=firestore.");
    }
    return new GcsDerivativeStore(config.storageBucket, config.firebaseProjectId);
  }
  return new InMemoryDerivativeStore();
}

/** Process-wide store; globalThis keeps the memory backend coherent in dev. */
export function getDerivativeStore(): DerivativeStore {
  globalStore.__pinnedDerivativeStore ??= createDerivativeStore();
  return globalStore.__pinnedDerivativeStore;
}
