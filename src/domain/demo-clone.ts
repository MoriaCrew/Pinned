/**
 * Demo clone plan (PIN-251, docs/DEPLOY.md §6.3): the pure half of
 * "See a board". Given a template board's content, build the records
 * of a fresh board for one visitor. Nothing here touches storage or a
 * repository; the server step (src/server/demo-board.ts) writes the
 * records in this order and performs the listed storage copies first.
 *
 * Sharing rules:
 * - Element FILES are shared with the template (same cutout and
 *   flattened refs). The PIN-85 library-copy rule already keeps shared
 *   cut-outs alive while any live board points at them, and the
 *   template is live for as long as it is the template.
 * - Scene PICTURES are copied into the new board's own `scenes/`
 *   folder: nothing protects a shared scene file (deleteSceneObjects
 *   removes a scene's folder outright), and a demo board's visitor may
 *   delete the scene they are looking at.
 * - Nothing identifying crosses over: cloned participants get fresh
 *   ids and fresh, unguessable cookie hashes nobody holds, no `userId`
 *   and no reclaim PIN, so no one can act as them. Elements lose
 *   `sourceElementId` (a library-copy provenance that would let the
 *   template's people "own" the clone's things).
 *
 * What is cloned: participants that own a kept element or made a kept
 * scene (plus the rest of the roster, so credits read the same names),
 * elements with a pinned pin or used by a kept scene, pinned pins only
 * (candidates belong to in-flight jobs), and ready, visible scenes
 * whose pins all survived. Every record is stamped `now`; both
 * repositories keep append order for equal timestamps, so the template
 * order is preserved.
 */
import {
  emptyBoardCounters,
  type Board,
  type BoardHost,
  type Element,
  type Participant,
  type Pin,
  type Scene,
} from "./board";

export interface DemoCloneSource {
  template: Board;
  participants: readonly Participant[];
  elements: readonly Element[];
  pins: readonly Pin[];
  /** Scenes as listed without hidden ones; the plan still filters status and tombstones. */
  scenes: readonly Scene[];
}

export interface DemoCloneOptions {
  /** The new board's slug (a fresh capability). */
  slug: string;
  title: string;
  now: number;
  /** When the sweep may delete the board (Policy.demo.ttlHours after now). */
  expiresAt: number;
  /** Host credential record for the visitor (the raw token goes in their cookie). */
  host: BoardHost;
  /** Free creations and free photos from Policy.demo, never the credits pool. */
  starterMakes: number;
  freePhotos: number;
  /** Fresh record ids (participants, elements, pins, scenes). */
  newId: () => string;
  /** A fresh cookie-secret hash per participant whose secret is discarded at once. */
  newCookieSecretHash: () => string;
}

export interface StorageCopy {
  from: string;
  to: string;
}

export interface DemoClonePlan {
  board: Board;
  participants: Participant[];
  elements: Element[];
  pins: Pin[];
  scenes: Scene[];
  /** Scene pictures to copy before the scenes are written (template ref -> clone ref). */
  copies: StorageCopy[];
}

/** `scenes/boards/{slug}/{sceneId}/{file}` -> the file name, or null for any other shape. */
export function sceneFileName(imageRef: string, boardId: string, sceneId: string): string | null {
  const folder = `scenes/boards/${boardId}/${sceneId}/`;
  if (!imageRef.startsWith(folder)) return null;
  const file = imageRef.slice(folder.length);
  return file && !file.includes("/") ? file : null;
}

export function planDemoClone(source: DemoCloneSource, options: DemoCloneOptions): DemoClonePlan {
  const { template } = source;
  const { slug, now } = options;

  // Scenes first: they decide which unpinned elements are still needed.
  const readyScenes = source.scenes.filter(
    (scene) => scene.status === "ready" && !scene.hidden && scene.deletedAt === undefined && !!scene.imageRef,
  );
  const pinnedPins = source.pins.filter((pin) => pin.status === "pinned");
  const pinnedElementIds = new Set(pinnedPins.map((pin) => pin.elementId));
  const sceneElementIds = new Set(readyScenes.flatMap((scene) => scene.elementIds));
  const knownElementIds = new Set(source.elements.map((element) => element.id));

  const keptElements = source.elements.filter(
    (element) => pinnedElementIds.has(element.id) || sceneElementIds.has(element.id),
  );
  // A scene whose pin no longer exists on the template is skipped: its
  // credits would name a thing the clone does not have.
  const keptScenes = readyScenes.filter((scene) =>
    scene.elementIds.length > 0 && scene.elementIds.every((id) => knownElementIds.has(id)),
  );
  const keptSceneIds = new Set(keptScenes.map((scene) => scene.id));

  const participantIds = new Map<string, string>();
  const participants: Participant[] = source.participants.map((participant) => {
    const id = options.newId();
    participantIds.set(participant.id, id);
    return {
      id,
      boardId: slug,
      displayName: participant.displayName,
      cookieSecretHash: options.newCookieSecretHash(),
      createdAt: now,
    };
  });
  const actor = (templateParticipantId: string): string | null =>
    participantIds.get(templateParticipantId) ?? null;

  const elementIds = new Map<string, string>();
  const elements: Element[] = [];
  for (const element of keptElements) {
    const ownerId = actor(element.ownerId);
    if (ownerId === null) continue; // an owner missing from the roster: nothing to attribute to
    const id = options.newId();
    elementIds.set(element.id, id);
    elements.push({
      id,
      boardId: slug,
      ownerId,
      label: element.label,
      description: element.description,
      maskBox: { ...element.maskBox },
      cutoutRef: element.cutoutRef,
      flattenedRef: element.flattenedRef,
      sourcePhotoId: element.sourcePhotoId,
      faceFlag: element.faceFlag,
      createdAt: now,
    });
  }

  const pins: Pin[] = [];
  for (const pin of pinnedPins) {
    const elementId = elementIds.get(pin.elementId);
    const pinnedBy = actor(pin.pinnedBy);
    if (!elementId || pinnedBy === null) continue;
    pins.push({ id: options.newId(), boardId: slug, elementId, pinnedBy, status: "pinned", createdAt: now });
  }

  const sceneIds = new Map<string, string>();
  const scenes: Scene[] = [];
  const copies: StorageCopy[] = [];
  for (const scene of keptScenes) {
    const createdBy = actor(scene.createdBy);
    const mapped = scene.elementIds.map((id) => elementIds.get(id));
    const file = sceneFileName(scene.imageRef as string, template.slug, scene.id);
    if (createdBy === null || mapped.some((id) => id === undefined) || file === null) continue;
    const id = options.newId();
    sceneIds.set(scene.id, id);
    const imageRef = `scenes/boards/${slug}/${id}/${file}`;
    copies.push({ from: scene.imageRef as string, to: imageRef });
    const parentSceneId =
      scene.parentSceneId && keptSceneIds.has(scene.parentSceneId) ? sceneIds.get(scene.parentSceneId) : undefined;
    scenes.push({
      id,
      boardId: slug,
      createdBy,
      elementIds: mapped as string[],
      prompt: scene.prompt,
      status: "ready",
      imageRef,
      ...(scene.width !== undefined ? { width: scene.width } : {}),
      ...(scene.height !== undefined ? { height: scene.height } : {}),
      ...(parentSceneId ? { parentSceneId } : {}),
      promptVersion: scene.promptVersion,
      ...(scene.kind ? { kind: scene.kind } : {}),
      ...(scene.collageReason ? { collageReason: scene.collageReason } : {}),
      createdAt: now,
    });
  }

  const board: Board = {
    slug,
    title: options.title,
    ...(template.themeId ? { themeId: template.themeId } : {}),
    ...(template.theme ? { theme: { ...template.theme } } : {}),
    host: { ...options.host },
    starterMakes: options.starterMakes,
    freePhotos: options.freePhotos,
    demo: { templateSlug: template.slug, expiresAt: options.expiresAt },
    demoSweepAt: options.expiresAt,
    counters: emptyBoardCounters(),
    createdAt: now,
    version: 1,
  };

  return { board, participants, elements, pins, scenes, copies };
}
