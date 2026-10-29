/**
 * Studio board entities (docs/11 §5.4, PIN-62). Pure types only —
 * persistence lives behind BoardRepository (board-repository.ts).
 * Times are epoch-ms numbers. Invariant: no field anywhere stores
 * an original photo; Element refs point at derived cut-outs under
 * `elements/` only.
 *
 * Identity: `ownerId` / `pinnedBy` / `createdBy` / `actorId` are
 * Participant ids today (link-only join identity, one per board).
 * PIN-57 links a Participant to a signed-in User via `userId`
 * without changing any stored owner reference.
 */
import type { PolicyOverrides } from "../policy/policy";
import type { BoardThemeTokens } from "./board-themes";

/** Mask bounding box, normalized 0..1 against the source frame
 * (the gateway port convention, ports.ts SegmentPrompt). The
 * DecomposeJob converts SAM wire pixel boxes by the frame size, so
 * the box stays valid after the working copy is deleted. */
export interface MaskBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface BoardCounters {
  participantCount: number;
  /** Live (non-deleted) elements on the board. */
  elementCount: number;
  /** Pins with status "pinned" (candidates do not count). */
  pinCount: number;
  /** Scenes on the board that are not hidden. */
  sceneCount: number;
}

export function emptyBoardCounters(): BoardCounters {
  return { participantCount: 0, elementCount: 0, pinCount: 0, sceneCount: 0 };
}

export interface Board {
  /** Capability-link slug; also the board id everywhere (`boardId`). */
  slug: string;
  title: string;
  /** Board theme id (docs/11 §5.10); absent = default theme. */
  themeId?: string;
  theme?: BoardThemeTokens;
  /** Per-board Policy layer (docs/11 §5.1); validated by resolvePolicy. */
  policyOverrides?: PolicyOverrides;
  counters: BoardCounters;
  createdAt: number;
  version: number; // optimistic-concurrency counter
}

/**
 * One person's identity on one board — the Studio name for the
 * existing join identity (`src/server/player-session.ts`): signed
 * cookie hashed into the record, optional reclaim PIN hash.
 * `userId` stays absent until PIN-57 sign-in claims the record.
 */
export interface Participant {
  id: string;
  boardId: string; // = Board.slug
  displayName: string;
  cookieSecretHash: string;
  reclaimPinHash?: string;
  userId?: string; // PIN-57 Firebase Auth uid, after claim
  createdAt: number;
}

export interface Element {
  id: string;
  /** Board the element was created on (its owner participates there). */
  boardId: string;
  ownerId: string; // Participant.id
  label: string;
  description: string;
  maskBox: MaskBox;
  /** Transparent cut-out PNG under `elements/` (persistent). */
  cutoutRef: string;
  /** White-flattened copy under `elements/` (scene input, §5.6). */
  flattenedRef: string;
  /** Id of the photo intake/decompose run; never a stored original. */
  sourcePhotoId: string;
  /** Spark flagged a visible face: consent note, never a block. */
  faceFlag: boolean;
  createdAt: number;
}

export type PinStatus = "candidate" | "pinned";

export interface Pin {
  id: string;
  boardId: string;
  elementId: string;
  pinnedBy: string; // Participant.id; may differ from Element.ownerId
  status: PinStatus;
  createdAt: number;
}

/** Job lifecycle shared with docs/11 §5.3. */
export type SceneStatus = "pending" | "running" | "ready" | "failed" | "refused";

export interface Scene {
  id: string;
  boardId: string;
  createdBy: string; // Participant.id
  elementIds: string[];
  prompt: string;
  status: SceneStatus;
  imageRef?: string; // under `scenes/` once ready
  parentSceneId?: string; // remix parent (§5.7)
  promptVersion: string; // e.g. "scene.v1", stored with every output
  costUsd?: number;
  refusalReason?: string;
  /** Set by the delete cascade when a used element is deleted (§5.4). */
  hidden?: boolean;
  createdAt: number;
}

/**
 * One photo-decompose run (docs/11 section 5.3, PIN-64). The job
 * id doubles as Element.sourcePhotoId. `workingRef` points at the
 * stripped working copy under `tmp/` (photo-intake derivative),
 * never at original upload bytes. `elementIds`/`pinIds` grow as
 * each SAM call lands, so a polling client sees candidate pins
 * pop in while the job is still running. Persistence lives behind
 * the DecomposeJobStore port in src/server/decompose-job.ts
 * (Firestore home boards/{slug}/jobs/{id} is reserved, PIN-63).
 */
export interface DecomposeJob {
  id: string;
  boardId: string;
  participantId: string; // Participant.id of the uploader
  status: SceneStatus; // pending -> running -> ready / failed / refused
  /** Stripped working copy under `tmp/`; deleted by later slices. */
  workingRef: string;
  /** Set when the working copy was deleted (PIN-65 A6a / TTL sweep). */
  workingDeletedAt?: number;
  promptVersion: string; // elements prompt actually used
  elementIds: string[];
  pinIds: string[];
  /** Policy faces=note and the namer flagged a face: show the note. */
  faceNote: boolean;
  /** Concepts that produced no usable pin (partial failure count). */
  failedConceptCount: number;
  errorCode?: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * One scene-compose run (docs/11 section 5.3, PIN-69). The job id
 * IS the Scene.id: the gallery polls the Scene, whose status is
 * kept in step with this record by the SceneJob service. Jobs are
 * idempotent by id with claim-before-call (only the caller that
 * flips pending -> running may call the SceneComposer port), so a
 * re-POST with the same id never double-bills. Persistence lives
 * behind the SceneJobStore port in src/server/scene-job.ts
 * (Firestore home boards/{slug}/sceneJobs/{id} — board-scoped doc
 * refs only, no collection-group query, so no new index).
 */
export interface SceneJob {
  id: string; // = Scene.id
  boardId: string;
  participantId: string; // Participant.id of the requester
  elementIds: string[];
  prompt: string;
  status: SceneStatus; // pending -> running -> ready / failed / refused
  promptVersion: string; // scene prompt actually used
  /** Stored scene image under `scenes/` once ready. */
  imageRef?: string;
  /** Cost estimate (gateway reserve proxy; dashboard authoritative). */
  costUsd?: number;
  refusalReason?: string;
  errorCode?: string;
  createdAt: number;
  updatedAt: number;
}

export type BoardEventType =
  | "element_added"
  | "pin_added"
  | "scene_requested"
  | "scene_ready"
  | "scene_refused"
  | "scene_failed";

/**
 * Append-only activity record. `element_added` / `pin_added` are
 * emitted by the repository itself (see BoardRepository); the
 * `scene_*` types are reserved for the scene slices, whose jobs
 * append them via `appendEvent`. No update or delete exists.
 */
export interface BoardEvent {
  id: string;
  boardId: string;
  type: BoardEventType;
  actorId: string; // Participant.id
  elementId?: string;
  pinId?: string;
  sceneId?: string;
  createdAt: number;
}
