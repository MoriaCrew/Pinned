"use client";

import { useEffect, useRef, useState } from "react";
import { notFound } from "next/navigation";
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  needsEmptyPrompt,
  pinCards,
  type BoardViewElement,
  type BoardViewLike,
  type BoardViewScene,
} from "../../../domain/board-view";
import {
  boardPollEnabled,
  boardPollError,
  showBoardGone,
  type BoardDeletePhase,
} from "../../../domain/board-delete-ui";
import { rollbackElementLabel, withElementLabel } from "../../../domain/element-label";
import {
  attemptPollInterval,
  isTerminalScene,
  pruneSelection,
  canRemixScene,
  scenesNewestFirst,
  selectableCards,
  togglePinSelection,
  chipsForSelection,
  chipsSelectionKey,
  withPolledScene,
} from "../../../domain/make-sheet";
import {
  boardCounts,
  explainsBudgetCollage,
  latestActivity,
  pickNumbers,
  pickedInOrder,
  remixSource,
  sceneCredits,
  sceneNumbers,
  sceneTag,
  stripItems,
} from "../../../domain/board-ui";
import { chooseShareAction, sceneShareFilename } from "../../../domain/board-preview";
import type { ActivityLine } from "../../../domain/board-activity";
import type { PlusView } from "../../../domain/plus";
import { sceneRatio } from "../../../domain/scene-ratio";
import { foilPinId, lookSample } from "../../../domain/plus-ui";
import { sceneIdInUrl, stepScene, urlWithScene, viewerSceneIds } from "../../../domain/scene-viewer";
import { skinForTheme, type SkinId } from "../../../domain/skins";
import { t, tCount, tf } from "../../../i18n";
import { useLocale } from "../../../i18n/client";
import {
  shouldShowSignInNudge,
  SIGN_IN_NUDGE_STORAGE_KEY,
} from "../../../domain/auth-ui";
import { BoardHeader, Button, Dock, EmptyState, Hint, cx } from "../../../ui";
import { useAuth } from "../../auth/AuthProvider";
import { You } from "../../auth/You";
import { AddSheet, type AddBatchStep, type PhotoMemory } from "./AddSheet";
import { boardQueryKey } from "./board-query";
import { useUploadQueue } from "./useUploadQueue";
import { nextStepItem, stepPosition } from "../../../domain/upload-queue";
import { createPhotoMemory } from "./photo-memory";
import { MakeSheet } from "./MakeSheet";
import { BoardScenes, type PrintSlot, type SceneSlot } from "./BoardScenes";
import { BoardThings } from "./BoardThings";
import { usePinFilter } from "./usePinFilter";
import { BoardLeftovers } from "./Leftovers";
import { leftoversOf } from "../../../domain/leftovers";
import { JoinSheet } from "./JoinSheet";
import { RenameSheet } from "./RenameSheet";
import { PlusFlow, useLookFlow } from "./PlusFlow";
import { DeleteBoardSheet } from "./DeleteBoardSheet";
import { isPoolEmptyCode, parseBillingFlag, poolEmptyCopy, type MakesPack } from "../../../domain/makes-ui";
import { BillingBanner, MakesIndicator, useMakesFlow } from "./MakesFlow";
import { SceneViewer } from "./SceneViewer";
import styles from "./board.module.css";

export interface BoardClientView extends BoardViewLike {
  board: { slug: string; title: string; themeId?: string | null };
  me: { id: string; displayName: string } | null;
  scenes: BoardViewScene[];
  activity: ActivityLine[];
  /** PIN-103: false in the server render (the host cookie is API-path scoped); the first poll says. */
  viewer?: { isHost: boolean; /** PIN-181: host, or joined while the board has Plus. */ canChangeLook: boolean };
  /** PIN-103: the board's Plus state and billing mode (the price comes from the Policy pack). */
  plus?: PlusView;
  /** PIN-151: present only while credits are enabled; PIN-152 renders it. */
  credits?: { availableMakes: number };
}

export interface BoardClientPolicy {
  pollIntervalMs: number;
  jobPollIntervalMs: number;
  uploadMaxPx: number;
  uploadJpegQuality: number;
  pinsPerScene: { min: number; max: number };
  sceneChips: string[];
  scenePromptMaxChars: number;
  /** Policy elementLabelMaxChars: the rename sheet's cap, in code points (PIN-157). */
  elementLabelMaxChars: number;
  /** Policy sceneSize (PIN-129): the print shape of a scene with no stored size. */
  sceneSize: string;
  /** Policy elementsPerPhoto.max, tap-adds included (PIN-78). */
  elementsPerPhotoMax: number;
  /** Policy batch upload: pick cap, client concurrency, transient-retry bounds. */
  photosPerBatch: number;
  batchUploadConcurrency: number;
  uploadRetryMaxAttempts: number;
  uploadRetryBackoffMs: number;
  /** Policy signInNudge (PIN-84). */
  signInNudge: boolean;
  /** Policy libraryStripMax: the Add sheet's "From your other boards" cap (PIN-121). */
  libraryStripMax: number;
  /** Policy dictation (PIN-119): clip cap; enabled = caps + AI budget on. */
  dictationMaxSeconds: number;
  dictationEnabled: boolean;
  /** Policy.credits offer for the creations UI (PIN-152): packs (the Plus sheet sells the first, PIN-182) + the low threshold. The indicator renders only while the board view carries credits. */
  makes?: { packs: MakesPack[]; lowMakesWarning: number };
}

interface SceneAttempt {
  /** Remix parent scene id (PIN-79); elementIds are the NEW pins. */
  parentSceneId?: string;
  sceneId: string;
  elementIds: string[];
  prompt: string;
  pinIds: string[];
}

/** What someone who has not joined yet was about to do (continued after joining). */
type JoinIntent =
  | { kind: "add" }
  | { kind: "make" }
  | { kind: "pick"; pinId: string }
  // The merged scene the print was built from (the job poll can mark
  // it ready before the board cache does).
  | { kind: "remix"; scene: BoardViewScene }
  // From the "you" menu (PIN-120): just the sheet, nothing to continue.
  | { kind: "join" }
  | { kind: "edit" }
  // PIN-152: buying makes needs a joined participant (or the host).
  | { kind: "buyMakes" };

/** localStorage key: the picking coach mark shows once. */
const PICK_HINT_STORAGE_KEY = "pinned.pickHintSeen";
/** How long "Link copied" stays under the header (display timing only). */
const SHARE_NOTICE_MS = 3000;

function newSceneId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `scene-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function isAbort(cause: unknown): boolean {
  return (
    (cause instanceof DOMException && cause.name === "AbortError") ||
    (cause instanceof Error && cause.name === "AbortError")
  );
}

function readFlag(key: string): boolean {
  try {
    return typeof window !== "undefined" && window.localStorage.getItem(key) === "1";
  } catch {
    return true;
  }
}

function writeFlag(key: string) {
  try {
    window.localStorage.setItem(key, "1");
  } catch {
    // Private mode: the in-memory flag still holds.
  }
}

/**
 * Studio board (PIN-66/67/70, rebuilt in PIN-98 on the design
 * system, docs/14): header, the Scenes strip, the Things grid and
 * the Dock in the thumb zone. TanStack Query polls the board view
 * (Policy cadence) so a second phone sees new pins and scenes.
 * "Make a scene" enters picking mode (up to Policy.pinsPerScene.max
 * things, from anyone), Next opens the Make sheet, and the scene
 * develops in the strip while its job is polled.
 */
export function BoardClient({
  slug,
  initialView,
  policy,
  tryOnSkin = null,
  initialSceneId = null,
  initialBilling = null,
}: {
  slug: string;
  initialView: BoardClientView;
  policy: BoardClientPolicy;
  /** `?tryon=<skin>`: the host's Plus try-on from the start flow (PIN-111). */
  tryOnSkin?: SkinId | null;
  /** `?scene=<id>`: the scene viewer opens on it (PIN-131). */
  initialSceneId?: string | null;
  /** `?billing=` from the billing return (PIN-152); validated in the makes flow. */
  initialBilling?: string | string[] | null;
}) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: true } },
      }),
  );
  return (
    <QueryClientProvider client={queryClient}>
      <BoardBody slug={slug} initialView={initialView} policy={policy} tryOnSkin={tryOnSkin} initialSceneId={initialSceneId} initialBilling={initialBilling} />
    </QueryClientProvider>
  );
}

function BoardBody({
  slug,
  initialView,
  policy,
  tryOnSkin,
  initialSceneId,
  initialBilling,
}: {
  slug: string;
  initialView: BoardClientView;
  policy: BoardClientPolicy;
  tryOnSkin: SkinId | null;
  initialSceneId: string | null;
  initialBilling: string | string[] | null;
}) {
  const locale = useLocale();
  const queryClient = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  // PIN-122: "Pin them" reopens the Add sheet at this photo's review;
  // the last photo's local preview survives sheet closes meanwhile.
  const [resumeJobId, setResumeJobId] = useState<string | null>(null);
  // Batch upload (multi-photo pick): the queue lives here so closing
  // the sheet never kills an upload; the sheet steps through items.
  const uploadQueue = useUploadQueue({
    slug,
    uploadMaxPx: policy.uploadMaxPx,
    uploadJpegQuality: policy.uploadJpegQuality,
    jobPollIntervalMs: policy.jobPollIntervalMs,
    photosPerBatch: policy.photosPerBatch,
    batchUploadConcurrency: policy.batchUploadConcurrency,
    uploadRetryMaxAttempts: policy.uploadRetryMaxAttempts,
    uploadRetryBackoffMs: policy.uploadRetryBackoffMs,
  });
  const [batchStepKey, setBatchStepKey] = useState<string | null>(null);
  const batchCurrent = batchStepKey
    ? (uploadQueue.items.find((item) => item.key === batchStepKey) ?? null)
    : null;
  const batchPosition = batchCurrent ? stepPosition(uploadQueue.items, batchCurrent.key) : null;
  const batchStepProp: AddBatchStep | null =
    batchCurrent && batchPosition
      ? {
          itemStatus: batchCurrent.status,
          previewUrl: batchCurrent.previewUrl ?? null,
          ...(batchCurrent.errorCode ? { errorCode: batchCurrent.errorCode } : {}),
          ...(batchCurrent.error ? { error: batchCurrent.error } : {}),
          index: batchPosition.index,
          total: batchPosition.total,
          states: uploadQueue.items.map((item) => item.status),
          droppedCount: uploadQueue.dropped,
          onConfirmed: () => advanceBatch(batchCurrent.key, "done"),
          onSkip: () => advanceBatch(batchCurrent.key, "skipped"),
          onRetry: () => uploadQueue.retryItem(batchCurrent.key),
        }
      : null;
  const [photoMemory] = useState<PhotoMemory>(createPhotoMemory);
  useEffect(
    () => () => {
      if (photoMemory.current) URL.revokeObjectURL(photoMemory.current.url);
    },
    [photoMemory],
  );
  const [makeOpen, setMakeOpen] = useState(false);
  // Picking mode: pins become toggles and the dock becomes the tray.
  const [picking, setPicking] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [attempt, setAttempt] = useState<SceneAttempt | null>(null);
  const [attemptError, setAttemptError] = useState("");
  // PIN-152: the attempt scene whose POST job already failed
  // pool-empty (terminal in the POST answer, so its poll may
  // never run — the copy must not depend on the poll alone).
  const [scenePoolEmptyId, setScenePoolEmptyId] = useState<string | null>(null);
  // Client clock start of the in-flight attempt (developing clock).
  const [attemptStartedAt, setAttemptStartedAt] = useState<number | null>(null);
  // Set only when a POST actually created the scene — polling a
  // client id that a 400/429 rejected would 404 forever.
  const [liveSceneId, setLiveSceneId] = useState<string | null>(null);
  // Sheet prompt seed: "" for a fresh scene; the refused/failed
  // attempt's prompt only via "Change idea".
  const [sheetPrompt, setSheetPrompt] = useState("");
  // PIN-79: remix mode — the ready scene the Make sheet extends.
  const [remixOfId, setRemixOfId] = useState<string | null>(null);
  // PIN-75: generated chips, keyed by the selection they were made for.
  const [generatedChips, setGeneratedChips] = useState<{ key: string; chips: string[] } | null>(null);
  const [confirmDeleteElementId, setConfirmDeleteElementId] = useState<string | null>(null);
  const [deleteErrorElementId, setDeleteErrorElementId] = useState<string | null>(null);
  // PIN-157: the thing whose rename sheet is open (mounted here, not in its More menu).
  const [renamingElementId, setRenamingElementId] = useState<string | null>(null);
  // Which opening of the sheet this is: a save made in an earlier
  // opening (even of the same thing) must not close or speak in this one.
  const [renamingOpenId, setRenamingOpenId] = useState(0);
  const renameOpens = useRef(0);
  // PIN-168: the host's Delete board confirm, and where our own delete is.
  const [deleteBoardOpen, setDeleteBoardOpen] = useState(false);
  const [deletePhase, setDeletePhase] = useState<BoardDeletePhase>("idle");
  const [sharingSceneId, setSharingSceneId] = useState<string | null>(null);
  const [shareErrorSceneId, setShareErrorSceneId] = useState<string | null>(null);
  // Join sheet: open while an intent waits for a name (or "edit").
  const [joinIntent, setJoinIntent] = useState<JoinIntent | null>(null);
  const [shareNotice, setShareNotice] = useState<"copied" | "failed" | null>(null);
  const [pickHintSeen, setPickHintSeen] = useState<boolean>(() => readFlag(PICK_HINT_STORAGE_KEY));
  // After a tap on a thing at rest starts picking, keep that thing in view.
  const [scrollToPinId, setScrollToPinId] = useState<string | null>(null);
  // PIN-131: the scene viewer. `?scene=` is its state: opening pushes
  // it, Back pops it, and a link that carries it opens the viewer.
  const [viewerId, setViewerId] = useState<string | null>(initialSceneId);
  const [sceneMissing, setSceneMissing] = useState(false);
  // PIN-143: the scene whose delete confirm is open in the viewer.
  const [confirmDeleteSceneId, setConfirmDeleteSceneId] = useState<string | null>(null);
  // While true, the entry is the one we pushed, so closing goes Back.
  const viewerPushed = useRef(false);
  // Runs once that entry has popped (Remix scrolls the board after it).
  const afterViewer = useRef<(() => void) | null>(null);
  // The print whose picture takes focus back when the viewer closes.
  const viewerReturnId = useRef(initialSceneId);
  useEffect(() => {
    const onPop = () => {
      viewerPushed.current = false;
      const id = sceneIdInUrl(window.location.href);
      // Forward can reopen the viewer: its print gets focus back again.
      if (id) viewerReturnId.current = id;
      setViewerId(id);
      afterViewer.current?.();
      afterViewer.current = null;
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const boardQuery = useQuery({
    queryKey: boardQueryKey(slug),
    queryFn: async (): Promise<BoardClientView> => {
      const response = await fetch(`/api/boards/${encodeURIComponent(slug)}`, {
        cache: "no-store",
      });
      if (!response.ok) throw boardPollError(response.status);
      return (await response.json()) as BoardClientView;
    },
    initialData: initialView,
    // PIN-168: no polling while our own delete is in flight or done.
    enabled: boardPollEnabled(deletePhase),
    refetchInterval: policy.pollIntervalMs,
    refetchIntervalInBackground: false,
  });
  const view = boardQuery.data;

  // PIN-111: the board's skin (first-generation theme ids map onto a
  // free skin) and the host's Change look / try-on / Board Plus flow.
  const boardSkin = skinForTheme(view.board.themeId);
  const isHost = view.viewer?.isHost === true;
  // PIN-183: the host, or a joined member while the board has Plus.
  const canChangeLook = view.viewer?.canChangeLook === true;
  const look = useLookFlow({
    slug,
    boardSkin,
    isHost,
    canChangeLook,
    plus: view.plus,
    tryOnParam: tryOnSkin,
    billingFlag: parseBillingFlag(initialBilling),
  });
  // PIN-152/182: creations indicator, the Plus sheet's stripe buy and
  // the return banner. The indicator is inert while the view carries
  // no credits; the sheet buys by Plus mode (stripe here, mock in PlusFlow).
  const makes = useMakesFlow({
    slug,
    availableMakes: view.credits?.availableMakes ?? null,
    initialAvailableMakes: initialView.credits?.availableMakes ?? null,
    plusMode: view.plus?.mode,
    billingParam: initialBilling,
  });
  const openBuyMakes = () => {
    if (view.me || isHost) makes.openSheet();
    else setJoinIntent({ kind: "buyMakes" });
  };

  // PIN-84: sign-in sync. Disabled (link-only) -> useAuth is the
  // inert default and everything below renders/runs nothing.
  const auth = useAuth();
  const [nudgeSeen, setNudgeSeen] = useState<boolean>(() => readFlag(SIGN_IN_NUDGE_STORAGE_KEY));
  const dismissNudge = () => {
    setNudgeSeen(true);
    writeFlag(SIGN_IN_NUDGE_STORAGE_KEY);
  };
  const authUid = auth.user?.uid ?? null;
  // PIN-86: refetch the board the moment sign-in state lands.
  // The board GET restores this user's participant from the user
  // cookie; waiting for the poll delayed restore and let a
  // racing join create a second identity.
  useEffect(() => {
    if (!authUid) return;
    void queryClient.invalidateQueries({ queryKey: boardQueryKey(slug) });
  }, [authUid, queryClient, slug]);
  const myParticipantId = view.me?.id ?? null;
  useEffect(() => {
    // Signed in on this board: link this participant right away
    // (the board poll would auto-claim too). Silent by design —
    // a 409 here means another account holds it; the header
    // still truthfully shows who is signed in.
    if (!authUid || !myParticipantId) return;
    void fetch(`/api/boards/${encodeURIComponent(slug)}/claim`, {
      method: "POST",
    }).catch(() => {});
  }, [authUid, myParticipantId, slug]);

  const handleJoined = (participant: { id: string; displayName: string }) => {
    // Apply the join response immediately, then let the next poll
    // reconcile with the server view.
    queryClient.setQueryData<BoardClientView>(boardQueryKey(slug), (current) =>
      current
        ? {
            ...current,
            me: participant,
            participants: current.participants.some((p) => p.id === participant.id)
              ? current.participants.map((p) =>
                  p.id === participant.id ? { ...p, ...participant } : p,
                )
              : [...current.participants, participant],
          }
        : current,
    );
    void queryClient.invalidateQueries({ queryKey: boardQueryKey(slug) });
  };

  const cards = pinCards(view);
  const selectableIds = selectableCards(cards).map((card) => card.pinId);
  // PIN-218: narrows the grid only; picks, pruning and the tray use every card.
  const pinFilter = usePinFilter(slug, cards, view.me?.id ?? null);

  useEffect(() => {
    setSelected((current) => {
      const pruned = pruneSelection(current, selectableIds);
      return pruned.size === current.size ? current : pruned;
    });
    // selectableIds identity changes per render; key on its content.
  }, [selectableIds.join(",")]);

  const makeScene = useMutation({
    mutationFn: async (sceneAttempt: SceneAttempt) => {
      const response = await fetch(
        `/api/boards/${encodeURIComponent(slug)}/scenes`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            elementIds: sceneAttempt.elementIds,
            prompt: sceneAttempt.prompt,
            sceneId: sceneAttempt.sceneId,
            ...(sceneAttempt.parentSceneId
              ? { parentSceneId: sceneAttempt.parentSceneId }
              : {}),
          }),
        },
      );
      const data = (await response.json()) as {
        scene?: BoardViewScene;
        job?: { errorCode?: string } | null;
        error?: string;
      };
      if (!response.ok || !data.scene) {
        throw new Error(data.error || t(locale, "board.sceneFailed"));
      }
      // PIN-152: a terminal pool-empty failure can arrive right
      // here; remember it for the problem card's copy.
      setScenePoolEmptyId(isPoolEmptyCode(data.job?.errorCode) ? data.scene.id : null);
      return data.scene;
    },
    onSuccess: (scene) => {
      // The picks are spent. Merge the POST's scene straight into
      // the board cache so the developing card hands over to the
      // real print with no empty poll gap, then let polls reconcile.
      setSelected(new Set());
      setRemixOfId(null);
      setLiveSceneId(scene.id);
      queryClient.setQueryData<BoardClientView>(boardQueryKey(slug), (current) =>
        current
          ? {
              ...current,
              scenes: current.scenes.some((s) => s.id === scene.id)
                ? current.scenes.map((s) => (s.id === scene.id ? scene : s))
                : [...current.scenes, scene],
            }
          : current,
      );
      void queryClient.invalidateQueries({ queryKey: boardQueryKey(slug) });
    },
    onError: (cause) =>
      setAttemptError(cause instanceof Error ? cause.message : t(locale, "board.sceneFailed")),
  });

  // PIN-77: delete my element (owner-only server-side; the
  // control only renders on own pins). The board poll reconciles
  // pins, hidden scenes and counters after invalidation.
  const deleteElement = useMutation({
    mutationFn: async (elementId: string) => {
      const response = await fetch(
        `/api/boards/${encodeURIComponent(slug)}/elements/${encodeURIComponent(elementId)}`,
        { method: "DELETE" },
      );
      if (!response.ok) throw new Error(t(locale, "board.deleteFailed"));
      return elementId;
    },
    onSuccess: (_data, elementId) => {
      // If my attempt scene used this element it is now hidden: drop
      // the attempt + poll cache, else the poll re-enables and merges
      // the stale polled scene back into the gallery.
      if (attempt && attempt.elementIds.includes(elementId)) {
        queryClient.removeQueries({ queryKey: ["board-scene", slug, liveSceneId] });
        setAttempt(null);
        setLiveSceneId(null);
        setAttemptError("");
      }
      setConfirmDeleteElementId(null);
      setDeleteErrorElementId(null);
      void queryClient.invalidateQueries({ queryKey: boardQueryKey(slug) });
    },
    onError: (_cause, elementId) => setDeleteErrorElementId(elementId),
  });

  // PIN-157: rename my element. Optimistic: the new name shows on the
  // grid, in credits and in the viewer at once (they all read
  // view.elements); a failure puts that one label back (only while the
  // board still shows the optimistic one) and the sheet, which stays
  // open until the answer, shows why. Only a 400 carries a line worth
  // showing (the server's own); 404 and the rest are generic. A late
  // answer touches only its own thing and its own sheet.
  const renameElement = useMutation({
    mutationFn: async ({ elementId, label }: { elementId: string; label: string; openId: number }) => {
      const response = await fetch(
        `/api/boards/${encodeURIComponent(slug)}/elements/${encodeURIComponent(elementId)}`,
        { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label }) },
      ).catch(() => null);
      const data = (await response?.json().catch(() => null)) as { element?: BoardViewElement; error?: string } | null;
      if (response?.status === 400 && data?.error) throw new Error(data.error);
      if (!response?.ok || !data?.element) throw new Error(t(locale, "board.renameFailed"));
      return data.element;
    },
    onMutate: async ({ elementId, label }) => {
      await queryClient.cancelQueries({ queryKey: boardQueryKey(slug) });
      const current = queryClient.getQueryData<BoardClientView>(boardQueryKey(slug));
      const previousLabel = current?.elements.find((e) => e.id === elementId)?.label;
      if (current) queryClient.setQueryData(boardQueryKey(slug), withElementLabel(current, elementId, label));
      return { previousLabel };
    },
    onSuccess: (element, { openId }) => {
      queryClient.setQueryData<BoardClientView>(boardQueryKey(slug), (current) =>
        current ? withElementLabel(current, element.id, element.label) : current,
      );
      // Close only the opening of the sheet that made this request.
      if (openId === renameOpens.current) setRenamingElementId((open) => (open === element.id ? null : open));
    },
    onError: (_cause, { elementId, label }, context) => {
      const previousLabel = context?.previousLabel;
      if (previousLabel === undefined) return;
      queryClient.setQueryData<BoardClientView>(boardQueryKey(slug), (current) =>
        current ? rollbackElementLabel(current, elementId, label, previousLabel) : current,
      );
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: boardQueryKey(slug) }),
  });
  const renamingElement = renamingElementId ? view.elements.find((e) => e.id === renamingElementId) : undefined;
  // The mutation tracks only its latest request: busy and the error line belong to the sheet of that thing.
  const renameIsForOpenSheet =
    renameElement.variables?.elementId === renamingElementId && renameElement.variables?.openId === renamingOpenId;

  // PIN-143: delete a scene (maker or host; the route enforces). Not
  // optimistic: the viewer stays open with its confirm until the
  // answer, so a failure's line stays on screen. The body carries no
  // code, so a 409 (still developing) is known by its status.
  const removeScene = useMutation({
    mutationFn: async (sceneId: string) => {
      const response = await fetch(
        `/api/boards/${encodeURIComponent(slug)}/scenes/${encodeURIComponent(sceneId)}`,
        { method: "DELETE" },
      ).catch(() => null);
      if (!response?.ok) {
        throw new Error(t(locale, response?.status === 409 ? "board.sceneDeleteDeveloping" : "board.deleteFailed"));
      }
      return sceneId;
    },
    onSuccess: (sceneId) => {
      // Drop the polled copy and my attempt, else the poll merges it back.
      queryClient.removeQueries({ queryKey: ["board-scene", slug, sceneId] });
      if (attempt?.sceneId === sceneId) {
        setAttempt(null);
        setLiveSceneId(null);
        setAttemptError("");
      }
      setConfirmDeleteSceneId(null);
      // Close first, so the deleter never gets "That scene isn't here
      // any more"; then it leaves the strip and the poll reconciles.
      // Focus goes to the next print (or the Scenes heading if none is left).
      if (viewerId === sceneId) {
        viewerReturnId.current = stepScene(viewerIds, sceneId, 1) ?? stepScene(viewerIds, sceneId, -1) ?? sceneId;
        closeViewer();
      }
      queryClient.setQueryData<BoardClientView>(boardQueryKey(slug), (current) =>
        current ? { ...current, scenes: current.scenes.filter((scene) => scene.id !== sceneId) } : current,
      );
      void queryClient.invalidateQueries({ queryKey: boardQueryKey(slug) });
    },
  });

  // Poll my in-flight scene at job cadence so the strip's print
  // lands faster than the board poll; both share the TanStack
  // cache and the poll stops at a terminal status, or at a 404
  // (scene: null): deleted by the host, or hidden (PIN-143).
  const attemptInView = attempt
    ? view.scenes.find((scene) => scene.id === attempt.sceneId)
    : undefined;
  const scenePoll = useQuery({
    queryKey: ["board-scene", slug, liveSceneId],
    queryFn: async (): Promise<{ scene: BoardViewScene | null; job: { errorCode?: string } | null }> => {
      const response = await fetch(
        `/api/boards/${encodeURIComponent(slug)}/scenes/${encodeURIComponent(liveSceneId ?? "")}`,
        { cache: "no-store" },
      );
      if (response.status === 404) return { scene: null, job: null };
      const data = (await response.json()) as { scene?: BoardViewScene; job?: { errorCode?: string } | null; error?: string };
      if (!response.ok || !data.scene) throw new Error(data.error || t(locale, "board.sceneFailed"));
      return { scene: data.scene, job: data.job ?? null };
    },
    enabled:
      liveSceneId !== null &&
      attempt?.sceneId === liveSceneId &&
      !makeScene.isPending &&
      !(attemptInView && isTerminalScene(attemptInView.status)),
    refetchInterval: (query) => attemptPollInterval(query.state.data, policy.jobPollIntervalMs),
  });
  const polledScene = scenePoll.data?.scene;
  // PIN-152: my scene lost the last-make race (PIN-151): its job
  // says so, and the problem card gets make-aware copy.
  const sceneJobPoolEmpty =
    isPoolEmptyCode(scenePoll.data?.job?.errorCode) ||
    (attempt !== null && scenePoolEmptyId === attempt.sceneId);
  const polledStatus = polledScene?.status;
  // My scene is gone: drop the attempt and its poll like a pin delete does.
  const attemptGone = polledScene === null;
  useEffect(() => {
    if (!attemptGone || liveSceneId === null) return;
    queryClient.removeQueries({ queryKey: ["board-scene", slug, liveSceneId] });
    setAttempt(null);
    setLiveSceneId(null);
    setAttemptError("");
  }, [attemptGone, liveSceneId, queryClient, slug]);
  useEffect(() => {
    if (polledStatus && isTerminalScene(polledStatus)) {
      void queryClient.invalidateQueries({ queryKey: boardQueryKey(slug) });
    }
  }, [polledStatus, queryClient, slug]);

  const scenes = scenesNewestFirst(withPolledScene(view.scenes, polledScene));
  const attemptScene = attempt ? scenes.find((scene) => scene.id === attempt.sceneId) : undefined;
  const showCooking = makeScene.isPending && !attemptScene;
  const picked = pickedInOrder(cards, selected);
  const pickedElementIds = [...new Set(picked.map((card) => card.element.id))];
  const selectionKey = chipsSelectionKey(pickedElementIds);
  // PIN-75: fixed Policy chips render instantly; generated chips
  // for this exact selection swap in when they land. The key is
  // captured with the result, so a slow response for a previous
  // selection can never overwrite the current picks.
  useEffect(() => {
    if (!makeOpen || !view.me || pickedElementIds.length === 0) return;
    let cancelled = false;
    const key = selectionKey;
    void (async () => {
      try {
        const response = await fetch(`/api/boards/${encodeURIComponent(slug)}/chips`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ elementIds: pickedElementIds }),
        });
        if (!response.ok) return;
        const data = (await response.json()) as { chips?: unknown; source?: unknown };
        if (cancelled || data.source === "fallback") return;
        const chips = Array.isArray(data.chips)
          ? data.chips.filter((chip): chip is string => typeof chip === "string" && chip.length > 0)
          : [];
        if (chips.length > 0) setGeneratedChips({ key, chips });
      } catch {
        // Fixed chips stay; generation is best-effort.
      }
    })();
    return () => {
      cancelled = true;
    };
    // pickedElementIds' content is keyed by selectionKey.
  }, [makeOpen, selectionKey, slug, view.me?.id]);
  const sheetChips = chipsForSelection(generatedChips, selectionKey, policy.sceneChips);
  // The remix parent from the live view (a deleted/hidden parent
  // drops out and the sheet degrades to a fresh scene).
  // From the merged list the prints use (job poll + board cache), so a
  // print the job poll just made ready is a valid parent at once.
  const remixParent = remixOfId
    ? scenes.find((scene) => scene.id === remixOfId && canRemixScene(scene))
    : undefined;
  const empty = needsEmptyPrompt(view);
  const leftovers = leftoversOf(view, view.me?.id);
  // Nothing to pick on an empty board: picking ends with it.
  const pickingNow = picking && !empty;

  // An emptied board ends picking for good, so the next pin to land
  // shows the board at rest, not a tray.
  useEffect(() => {
    if (!empty || !picking) return;
    setPicking(false);
    setSelected(new Set());
    setRemixOfId(null);
    setSheetPrompt("");
  }, [empty, picking]);

  useEffect(() => {
    if (!scrollToPinId || !pickingNow) return;
    document
      .querySelector(`[data-pin-id="${CSS.escape(scrollToPinId)}"]`)
      ?.scrollIntoView({ block: "center" });
    setScrollToPinId(null);
  }, [scrollToPinId, pickingNow]);

  useEffect(() => {
    if (shareNotice !== "copied") return;
    const timer = window.setTimeout(() => setShareNotice(null), SHARE_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [shareNotice]);

  function togglePin(pinId: string) {
    // Functional update: fast successive taps must each see the
    // previous pick, not the render-time snapshot.
    setSelected(
      (current) => togglePinSelection(current, pinId, policy.pinsPerScene.max).next,
    );
  }

  // Picking starts from a clean tray (a remix sets its parent first).
  function startPicking() {
    setSelected(new Set());
    setSheetPrompt("");
    setPicking(true);
    window.scrollTo({ top: 0 });
  }

  function exitPicking() {
    setPicking(false);
    setSelected(new Set());
    setSheetPrompt("");
    setRemixOfId(null);
  }

  function submitScene(input: { elementIds: string[]; prompt: string; pinIds: string[]; parentSceneId?: string }) {
    // A fresh sceneId per Make-it press; the network retry below
    // reuses it, which the server treats idempotently (PIN-69).
    const sceneAttempt: SceneAttempt = { ...input, sceneId: newSceneId() };
    setAttempt(sceneAttempt);
    setScenePoolEmptyId(null);
    setAttemptError("");
    setAttemptStartedAt(Date.now());
    setLiveSceneId(null);
    setMakeOpen(false);
    setPicking(false);
    setSheetPrompt("");
    makeScene.mutate(sceneAttempt);
  }

  function retryScene() {
    if (!attempt) return;
    setAttemptError("");
    setAttemptStartedAt(Date.now());
    makeScene.mutate(attempt);
  }

  // A scene that failed server-side keeps failing under its own id
  // (idempotent), so "Try again" makes it afresh with the same picks
  // and idea; a POST that never landed retries the same id.
  function tryAgain() {
    if (!attempt) return;
    if (attemptScene?.status === "failed") {
      submitScene({
        elementIds: attempt.elementIds,
        prompt: attempt.prompt,
        pinIds: attempt.pinIds,
        ...(attempt.parentSceneId ? { parentSceneId: attempt.parentSceneId } : {}),
      });
      return;
    }
    retryScene();
  }

  function changeIdea() {
    if (!attempt) return;
    setSelected(pruneSelection(new Set(attempt.pinIds), selectableIds));
    setSheetPrompt(attempt.prompt);
    setRemixOfId(attempt.parentSceneId ?? null);
    setPicking(true);
    setMakeOpen(true);
  }

  function startRemix(scene: BoardViewScene) {
    // Fresh picks for the remix: the parent carries its own pins
    // in its image; the cap counts only these new ones (PIN-79).
    setRemixOfId(scene.id);
    setSheetPrompt("");
    setAttemptError("");
    startPicking();
  }

  // Keeps any idea restored by Change idea; a new picking session
  // (startPicking / exitPicking / submit) is what clears it.
  function openMakeSheet() {
    setMakeOpen(true);
  }

  /** Step the batch past one item (pinned or skipped), or close at the end. */
  function advanceBatch(key: string, treated: "done" | "skipped") {
    if (treated === "done") uploadQueue.markDone(key);
    else uploadQueue.skipItem(key);
    const next = nextStepItem(
      uploadQueue.items.map((item) => (item.key === key ? { ...item, status: treated } : item)),
    );
    if (next) {
      setBatchStepKey(next.key);
    } else {
      setBatchStepKey(null);
      setAddOpen(false);
    }
  }

  function handlePickFiles(files: File[]) {
    const firstKey = uploadQueue.enqueue(files);
    // Topping up an in-flight batch steps to its earliest
    // unfinished photo, never past it to the newly picked ones.
    // Even when the whole top-up was over the batch cap (enqueue
    // created nothing), open that step: the batch sheet shows the
    // dropped-files note instead of the pick vanishing silently.
    const stepKey = nextStepItem(uploadQueue.items)?.key ?? firstKey;
    if (stepKey) {
      setResumeJobId(null);
      setBatchStepKey(stepKey);
    }
  }

  function runIntent(intent: JoinIntent) {
    if (intent.kind === "add") {
      // An unfinished batch resumes at its next photo; else a fresh pick.
      setBatchStepKey(nextStepItem(uploadQueue.items)?.key ?? null);
      setResumeJobId(null);
      setAddOpen(true);
    } else if (intent.kind === "make") {
      setRemixOfId(null);
      startPicking();
    } else if (intent.kind === "pick") {
      if (picking) {
        togglePin(intent.pinId);
      } else {
        // A tap on a thing at rest starts picking with that thing.
        setRemixOfId(null);
        setSheetPrompt("");
        setSelected(togglePinSelection(new Set(), intent.pinId, policy.pinsPerScene.max).next);
        setPicking(true);
        setScrollToPinId(intent.pinId);
      }
    } else if (intent.kind === "buyMakes") {
      makes.openSheet();
    } else if (intent.kind === "remix") {
      if (canRemixScene(intent.scene)) startRemix(intent.scene);
    }
  }

  // The board shows the moment the link opens; a name is asked
  // only when someone first acts, then the action carries on.
  function requireJoin(intent: JoinIntent) {
    if (view.me) runIntent(intent);
    else setJoinIntent(intent);
  }

  function onJoined(participant: { id: string; displayName: string }) {
    handleJoined(participant);
    const intent = joinIntent;
    setJoinIntent(null);
    if (intent) runIntent(intent);
  }

  function dismissPickHint() {
    setPickHintSeen(true);
    writeFlag(PICK_HINT_STORAGE_KEY);
  }

  // Share the board link: the phone's share sheet when there is
  // one, else copy it. A cancelled share sheet is silent.
  async function shareBoard() {
    setShareNotice(null);
    const url = `${window.location.origin}/g/${encodeURIComponent(slug)}`;
    const nav = navigator as Navigator & { canShare?: (data?: ShareData) => boolean };
    const data: ShareData = { title: view.board.title, url };
    if (typeof nav.share === "function" && (!nav.canShare || nav.canShare(data))) {
      try {
        await nav.share(data);
        return;
      } catch (cause) {
        if (isAbort(cause)) return;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      setShareNotice("copied");
    } catch {
      setShareNotice("failed");
    }
  }

  // PIN-72: share the scene image file when the browser can,
  // else the board link, else download. A user-cancelled sheet
  // (AbortError) is silent; success is never claimed in the UI.
  async function shareScene(scene: BoardViewScene) {
    if (!scene.imageUrl || sharingSceneId) return;
    setSharingSceneId(scene.id);
    setShareErrorSceneId(null);
    // The link opens this scene's viewer (PIN-131).
    const pageUrl = urlWithScene(window.location.href, scene.id).split("#")[0] ?? window.location.href;
    const shareText = scene.prompt;
    let blob: Blob | null = null;
    let file: File | null = null;
    try {
      if (typeof navigator !== "undefined" && "share" in navigator) {
        try {
          const response = await fetch(scene.imageUrl);
          if (response.ok) {
            blob = await response.blob();
            file = new File([blob], sceneShareFilename(scene.id, blob.type), {
              type: blob.type || "image/png",
            });
          }
        } catch {
          file = null;
        }
      }
      const nav = navigator as Navigator & {
        canShare?: (data?: ShareData) => boolean;
      };
      const canShareFiles = Boolean(
        file && nav.canShare && nav.canShare({ files: [file] }),
      );
      const urlData: ShareData = { title: view.board.title, text: shareText, url: pageUrl };
      const canShareUrl = Boolean(
        "share" in navigator && (!nav.canShare || nav.canShare(urlData)),
      );
      const action = chooseShareAction({ canShareFiles, canShareUrl });
      if (action === "files" && file) {
        await navigator.share({ title: view.board.title, text: shareText, files: [file] });
        return;
      }
      if (action === "url") {
        await navigator.share(urlData);
        return;
      }
      if (!blob) {
        const response = await fetch(scene.imageUrl);
        if (!response.ok) throw new Error("download failed");
        blob = await response.blob();
      }
      const objectUrl = URL.createObjectURL(blob);
      try {
        const link = document.createElement("a");
        link.href = objectUrl;
        link.download = sceneShareFilename(scene.id, blob.type);
        document.body.appendChild(link);
        link.click();
        link.remove();
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
    } catch (cause) {
      if (isAbort(cause)) return;
      setShareErrorSceneId(scene.id);
    } finally {
      setSharingSceneId(null);
    }
  }

  // History data is null so Next's router copies its own state and
  // learns the new URL (with its state passed in, it would not).
  function openViewer(sceneId: string) {
    if (viewerPushed.current) return; // a second tap before the viewer renders
    viewerReturnId.current = sceneId;
    setSceneMissing(false);
    window.history.pushState(null, "", urlWithScene(window.location.href, sceneId));
    viewerPushed.current = true;
    setViewerId(sceneId);
  }

  // Stepping replaces the entry, so Back still closes the viewer.
  function stepViewer(step: 1 | -1) {
    const next = viewerId ? stepScene(viewerIds, viewerId, step) : null;
    if (!next) return;
    window.history.replaceState(null, "", urlWithScene(window.location.href, next));
    viewerReturnId.current = next;
    setViewerId(next);
  }

  function closeViewer(then?: () => void) {
    setViewerId(null);
    if (then) viewerReturnId.current = null;
    if (viewerPushed.current) {
      viewerPushed.current = false;
      afterViewer.current = then ?? null;
      window.history.back();
      return;
    }
    window.history.replaceState(null, "", urlWithScene(window.location.href, null));
    then?.();
  }

  // ---------- View model for rendering ----------

  const counts = boardCounts(view);
  // Everyone but you: you are the "you" button (PIN-120).
  const people = view.participants
    .filter((p) => p.id !== view.me?.id)
    .map((p) => ({ id: p.id, name: p.displayName }));
  const latest = latestActivity(view.activity);
  const latestLine = latest
    ? tf(locale, `activity.${latest.kind}` as const, {
        name: latest.name ?? t(locale, "board.someone"),
        thing: latest.thing ?? "",
      })
    : null;
  const elementsById = new Map(view.elements.map((element) => [element.id, element]));
  const stickersFor = (elementIds: readonly string[]) =>
    elementIds.flatMap((id) => {
      const element = elementsById.get(id);
      return element ? [{ src: element.imageUrl, seed: id }] : [];
    });
  const numbers = sceneNumbers(scenes);
  // PIN-129: a print takes its stored shape; a slot with no image yet
  // takes the Policy shape, so it does not jump when the print lands.
  const slotRatio = sceneRatio(null, policy.sceneSize);

  const slots: SceneSlot[] = [];
  if (attempt && showCooking) {
    slots.push({
      type: "developing",
      ratio: slotRatio,
      id: attempt.sceneId,
      stickers: stickersFor(attempt.elementIds),
      idea: attempt.prompt,
      startedAt: attemptStartedAt,
    });
  } else if (attempt && attemptError && !attemptScene) {
    slots.push({
      type: "problem",
      ratio: slotRatio,
      id: attempt.sceneId,
      idea: attempt.prompt,
      line: attemptError,
      onChangeIdea: changeIdea,
      onTryAgain: tryAgain,
    });
  }
  const strip = stripItems(scenes, attempt?.sceneId ?? null);
  const viewerIds = viewerSceneIds(strip);
  for (const item of strip) {
    const scene = item.scene;
    if (item.mode === "developing") {
      slots.push({
        type: "developing",
        ratio: slotRatio,
        id: scene.id,
        stickers: stickersFor(scene.elementIds),
        idea: scene.prompt,
        startedAt: item.mine ? attemptStartedAt : null,
      });
    } else if (item.mode === "problem") {
      const refused = scene.status === "refused";
      // PIN-183: the last-creation race loser gets an invitation, not an error.
      const poolEmpty =
        scene.id === attempt?.sceneId && sceneJobPoolEmpty
          ? poolEmptyCopy("scene", {
              canBuy: makes.canBuy && Boolean(view.credits),
              plusActive: view.plus?.active === true,
            })
          : null;
      slots.push({
        type: "problem",
        ratio: slotRatio,
        id: scene.id,
        idea: scene.prompt,
        line: poolEmpty
          ? t(locale, poolEmpty.line)
          : refused
            ? (scene.refusalReason ?? t(locale, "ai.refused"))
            : t(locale, "board.sceneFailed"),
        action: poolEmpty?.action ? { label: t(locale, poolEmpty.action), onSelect: openBuyMakes } : undefined,
        onChangeIdea: changeIdea,
        // A refusal repeats for the same idea: only a new idea helps.
        onTryAgain: refused ? undefined : tryAgain,
      });
    } else if (scene.imageUrl) {
      const credits = sceneCredits(scene, view.elements, view.participants, view.scenes);
      const things = credits
        .map((credit) =>
          credit.owner ? tf(locale, "ui.ownerThing", { owner: credit.owner.name, thing: credit.thing }) : credit.thing,
        )
        .join(", ");
      slots.push({
        type: "print",
        ratio: sceneRatio(scene, policy.sceneSize),
        id: scene.id,
        src: scene.imageUrl,
        previewSrc: scene.previewUrl ?? scene.imageUrl,
        alt: things ? tf(locale, "board.sceneAlt", { idea: scene.prompt, things }) : scene.prompt,
        idea: scene.prompt,
        credits,
        kind: sceneTag(scene),
        remixOf: remixSource(scene, view.scenes, view.participants),
        number: numbers.get(scene.id),
        onRemix: canRemixScene(scene) ? () => requireJoin({ kind: "remix", scene }) : undefined,
        onShare: () => void shareScene(scene),
        onOpen: () => openViewer(scene.id),
        sharing: sharingSceneId === scene.id,
        footer:
          shareErrorSceneId === scene.id ? (
            <p className={styles.error} role="alert">
              {t(locale, "share.failed")}
            </p>
          ) : explainsBudgetCollage(scene) ? (
            <p className={styles.collageNote}>{t(locale, "makes.collageBudget")}</p>
          ) : null,
      });
    }
  }

  const viewerSlot = slots.find((slot): slot is PrintSlot => slot.type === "print" && slot.id === viewerId);
  const viewerOpen = viewerSlot !== undefined;
  // Host-only Delete appears after the first poll (the page render has no host cookie).
  const viewerCanDelete = viewerSlot ? scenes.find((scene) => scene.id === viewerSlot.id)?.canDelete === true : false;
  // A confirm belongs to one opening of one scene.
  useEffect(() => setConfirmDeleteSceneId(null), [viewerId]);
  // An unknown, hidden or deleted scene: the board with one quiet line,
  // and no `?scene=` left for Back to reopen.
  useEffect(() => {
    if (viewerId === null || viewerIds.includes(viewerId)) return;
    viewerReturnId.current = null;
    setSceneMissing(true);
    closeViewer();
    // viewerIds' content is keyed by its join; closeViewer reads refs.
  }, [viewerId, viewerIds.join(",")]);
  useEffect(() => {
    const id = viewerReturnId.current;
    if (viewerOpen || !id) return;
    viewerReturnId.current = null;
    const print = document.querySelector<HTMLElement>(`[data-scene-id="${CSS.escape(id)}"] .pn-print-open`);
    (print ?? document.getElementById("board-scenes"))?.focus();
  }, [viewerOpen]);

  const showNudge = shouldShowSignInNudge({
    authEnabled: auth.enabled,
    authLoading: auth.status === "loading",
    policyNudge: policy.signInNudge,
    signedIn: auth.user !== null,
    joined: view.me !== null,
    myPinnedCount: cards.filter(
      (card) => card.status === "pinned" && card.ownerId === view.me?.id,
    ).length,
    seenBefore: nudgeSeen,
  });

  const showScenes = !pickingNow && (!empty || slots.length > 0);
  const atMax = picked.length >= policy.pinsPerScene.max;
  const showDock = !empty;
  const lookSampleUrls = lookSample(cards);

  // PIN-168: the host deleted this board while it was open here (the
  // poll got a 404). Show the not-found an unknown link shows; that
  // unmounts the board, so the polling stops with it. Not while our own
  // delete is in flight or done: that 404 is ours, and the host lands
  // on the "Board deleted" page instead.
  if (showBoardGone(deletePhase, boardQuery.error)) notFound();

  return (
    <div className="pn-skin-root" data-theme={look.shownSkin} style={{ minHeight: "100dvh" }}>
      <main className={cx(styles.board, !showDock && styles.boardRest, look.tryOn && styles.boardTryOn)} inert={viewerOpen}>
        <BoardHeader
          title={view.board.title}
          people={people}
          peopleLabel={tf(locale, "you.alsoHere", { names: people.map((p) => p.name).join(", ") })}
          counts={counts}
          onShare={() => void shareBoard()}
          homeHref="/"
          you={
            <You
              board={{
                me: view.me,
                isHost,
                canChangeLook,
                plus: view.credits
                  ? { active: view.plus?.active === true, availableMakes: view.credits.availableMakes }
                  : null,
                onJoin: () => setJoinIntent({ kind: "join" }),
                onEditName: () => setJoinIntent({ kind: "edit" }),
                onChangeLook: look.openLook,
                onBoardPlus: openBuyMakes,
                onDeleteBoard: () => setDeleteBoardOpen(true),
              }}
            />
          }
        />

        <div className={styles.under}>
          {makes.banner ? (
            <BillingBanner
              kind={makes.banner}
              availableMakes={view.credits?.availableMakes ?? null}
              plusActive={view.plus?.active === true}
              onDismiss={makes.dismissBanner}
              locale={locale}
            />
          ) : null}
          <MakesIndicator
            locale={locale}
            credits={view.credits}
            lowMakesWarning={policy.makes?.lowMakesWarning ?? 0}
            plusActive={view.plus?.active === true}
            canBuy={makes.canBuy}
            onAddMakes={openBuyMakes}
          />
          {latestLine && !pickingNow ? (
            <p className={cx("pn-board-meta", styles.latest)}>
              <span className="pn-sr">{t(locale, "board.activity")}: </span>
              {latestLine}
            </p>
          ) : null}
          {sceneMissing ? (
            <p className="pn-board-meta" role="status">
              {t(locale, "board.sceneMissing")}
            </p>
          ) : null}
          {shareNotice ? (
            <p className={shareNotice === "copied" ? styles.notice : styles.error} role="status">
              {shareNotice === "copied" ? t(locale, "share.copied") : t(locale, "share.copyFailed")}
            </p>
          ) : null}
          {boardQuery.isError && deletePhase === "idle" ? (
            <div className={styles.errorRow}>
              <p className={styles.error} role="alert">
                {t(locale, "board.loadError")}
              </p>
              <Button size="sm" onClick={() => void boardQuery.refetch()}>
                {t(locale, "board.retry")}
              </Button>
            </div>
          ) : null}
          {showNudge ? (
            <div className={styles.nudge} role="status">
              <p>{t(locale, "auth.nudge")}</p>
              <div className={styles.nudgeActions}>
                <Button
                  size="sm"
                  onClick={() => {
                    dismissNudge();
                    void auth.signIn();
                  }}
                >
                  {t(locale, "auth.signIn")}
                </Button>
                <Button variant="quiet" size="sm" onClick={dismissNudge}>
                  {t(locale, "auth.nudgeDismiss")}
                </Button>
              </div>
            </div>
          ) : null}
        </div>

        {pickingNow ? (
          <div className={styles.hintRow}>
            {remixParent ? (
              <Hint onDismiss={exitPicking} dismissLabel={t(locale, "board.stop")} x={40}>
                {tf(locale, "board.remixing", { idea: remixParent.prompt })}
              </Hint>
            ) : !pickHintSeen ? (
              <Hint onDismiss={dismissPickHint} x={40}>
                {tCount(locale, "board.pickHint", policy.pinsPerScene.max)}
              </Hint>
            ) : atMax ? (
              <p className="pn-board-meta" role="status">
                {tf(locale, "board.pickMax", { n: policy.pinsPerScene.max })}
              </p>
            ) : null}
          </div>
        ) : null}

        {showScenes ? <BoardScenes slots={slots} count={counts.scenes} /> : null}

        {view.me && !addOpen && !pickingNow && leftovers.count > 0 ? (
          <BoardLeftovers
            slug={slug}
            leftovers={leftovers}
            elements={view.elements}
            onPin={(group) => {
              // A leftover from this session's batch reopens as its
              // batch step (preview + tap-to-add ride along, and
              // confirming marks the queue item done) instead of a
              // bare resume the queue would later resurface.
              const queued = uploadQueue.items.find((item) => item.uploadId === group.jobId);
              if (queued) {
                setBatchStepKey(queued.key);
                setResumeJobId(null);
              } else {
                setBatchStepKey(null);
                setResumeJobId(group.jobId);
              }
              setAddOpen(true);
            }}
          />
        ) : null}

        {empty && !pickingNow ? (
          <EmptyState onAction={() => requireJoin({ kind: "add" })} onShare={() => void shareBoard()} />
        ) : null}

        {/* Pinned things only; leftovers have their own line (PIN-122). */}
        {!empty ? (
          <BoardThings
            cards={cards}
            count={counts.things}
            meId={view.me?.id ?? null}
            picking={pickingNow}
            pickNumbers={pickNumbers(cards, selected)}
            foilPinId={foilPinId(cards, view.plus)}
            showHead={!pickingNow}
            filter={pinFilter}
            onTapPin={(pinId) => requireJoin({ kind: "pick", pinId })}
            onRename={(elementId) => {
              renameElement.reset();
              renameOpens.current += 1;
              setRenamingOpenId(renameOpens.current);
              setRenamingElementId(elementId);
            }}
            deletion={{
              confirmElementId: confirmDeleteElementId,
              errorElementId: deleteErrorElementId,
              deletingElementId: deleteElement.isPending ? (deleteElement.variables ?? null) : null,
              onAsk: (elementId) => {
                setDeleteErrorElementId(null);
                setConfirmDeleteElementId(elementId);
              },
              onConfirm: (elementId) => deleteElement.mutate(elementId),
              onCancel: () => setConfirmDeleteElementId(null),
            }}
          />
        ) : null}

        {showDock ? (
          <>
            <div
              className={cx(styles.fade, (look.tryOn || look.state.notice) && styles.fadeTall)}
              aria-hidden="true"
            />
            {pickingNow ? (
              <Dock
                mode="picking"
                fixed
                picked={picked.map((card) => ({ src: card.element.imageUrl, label: card.element.label }))}
                max={policy.pinsPerScene.max}
                onCancel={exitPicking}
                onNext={openMakeSheet}
                nextDisabled={picked.length < policy.pinsPerScene.min}
              />
            ) : (
              <Dock
                fixed
                onAdd={() => requireJoin({ kind: "add" })}
                onMake={() => requireJoin({ kind: "make" })}
                makeDisabled={selectableIds.length === 0}
              />
            )}
          </>
        ) : null}

        {addOpen && view.me ? (
          <AddSheet
            key={
              batchCurrent
                ? `batch-${batchCurrent.key}-${batchCurrent.uploadId}`
                : (resumeJobId ?? "new")
            }
            slug={slug}
            meId={view.me.id}
            boardView={view}
            uploadMaxPx={policy.uploadMaxPx}
            uploadJpegQuality={policy.uploadJpegQuality}
            jobPollIntervalMs={policy.jobPollIntervalMs}
            elementsPerPhotoMax={policy.elementsPerPhotoMax}
            libraryStripMax={policy.libraryStripMax}
            resumeJobId={batchCurrent ? batchCurrent.uploadId : resumeJobId}
            onAddMakes={
              makes.canBuy && view.credits
                ? () => {
                    setAddOpen(false);
                    setBatchStepKey(null);
                    setResumeJobId(null);
                    openBuyMakes();
                  }
                : undefined
            }
            onPickFiles={handlePickFiles}
            batch={batchStepProp}
            photoMemory={photoMemory}
            onClose={() => {
              setAddOpen(false);
              setBatchStepKey(null);
              setResumeJobId(null);
            }}
          />
        ) : null}

        {makeOpen && view.me ? (
          <MakeSheet
            cards={picked}
            chips={sheetChips}
            pinsPerScene={policy.pinsPerScene}
            promptMaxChars={policy.scenePromptMaxChars}
            dictate={
              policy.dictationEnabled
                ? { slug, maxSeconds: policy.dictationMaxSeconds }
                : null
            }
            initialPrompt={sheetPrompt}
            remixParent={
              remixParent?.imageUrl
                ? {
                    id: remixParent.id,
                    imageUrl: remixParent.previewUrl ?? remixParent.imageUrl,
                    prompt: remixParent.prompt,
                    ratio: sceneRatio(remixParent, policy.sceneSize),
                  }
                : null
            }
            onMake={submitScene}
            onClose={() => setMakeOpen(false)}
          />
        ) : null}

        {joinIntent ? (
          <JoinSheet
            slug={slug}
            me={view.me}
            profileName={auth.user?.displayName ?? null}
            onJoined={onJoined}
            onClose={() => setJoinIntent(null)}
          />
        ) : null}

        {renamingElement ? (
          <RenameSheet
            label={renamingElement.label}
            maxChars={policy.elementLabelMaxChars}
            busy={renameIsForOpenSheet && renameElement.isPending}
            error={renameIsForOpenSheet ? (renameElement.error?.message ?? "") : ""}
            onSave={(label) => {
              if (label === renamingElement.label) setRenamingElementId(null);
              else renameElement.mutate({ elementId: renamingElement.id, label, openId: renamingOpenId });
            }}
            onEdit={() => {
              if (renameElement.isError) renameElement.reset();
            }}
            onClose={() => setRenamingElementId(null)}
          />
        ) : null}

        {isHost && deleteBoardOpen ? (
          <DeleteBoardSheet
            slug={slug}
            title={view.board.title}
            signedIn={auth.enabled && auth.status === "signedIn"}
            onPhase={(phase) => {
              setDeletePhase(phase);
              if (phase === "left") queryClient.removeQueries({ predicate: (query) => query.queryKey[1] === slug });
            }}
            onClose={() => setDeleteBoardOpen(false)}
          />
        ) : null}

        {/* Everyone can open the Plus sheet; the try-on and Keep it stay host-only inside the look flow. */}
        <PlusFlow
          look={look}
          makes={makes}
          boardSkin={boardSkin}
          plus={view.plus}
          pack={policy.makes?.packs[0] ?? null}
          isHost={isHost}
          sample={lookSampleUrls}
          foilSrc={lookSampleUrls[0]}
          aboveDock={showDock}
          picking={pickingNow}
        />
      </main>
      {viewerSlot ? (
        <SceneViewer
          slot={viewerSlot}
          onClose={() => closeViewer()}
          onStep={stepViewer}
          onRemix={viewerSlot.onRemix ? () => closeViewer(viewerSlot.onRemix) : undefined}
          more={
            viewerCanDelete
              ? [
                  {
                    label: t(locale, "board.delete"),
                    danger: true,
                    onSelect: () => {
                      removeScene.reset();
                      setConfirmDeleteSceneId(viewerSlot.id);
                    },
                  },
                ]
              : undefined
          }
          confirmDelete={
            confirmDeleteSceneId === viewerSlot.id
              ? {
                  deleting: removeScene.isPending,
                  error: removeScene.isError && removeScene.variables === viewerSlot.id ? removeScene.error.message : null,
                  onConfirm: () => removeScene.mutate(viewerSlot.id),
                  onKeep: () => {
                    if (removeScene.isPending) return;
                    removeScene.reset();
                    setConfirmDeleteSceneId(null);
                  },
                }
              : null
          }
        />
      ) : null}
    </div>
  );
}
