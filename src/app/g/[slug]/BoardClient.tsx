"use client";

import { useEffect, useRef, useState } from "react";
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
  type BoardViewLike,
  type BoardViewScene,
} from "../../../domain/board-view";
import {
  isTerminalScene,
  pruneSelection,
  canRemixScene,
  scenesNewestFirst,
  selectableCards,
  togglePinSelection,
  chipsForSelection,
  chipsSelectionKey,
} from "../../../domain/make-sheet";
import {
  boardCounts,
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
import {
  shouldShowSignInNudge,
  SIGN_IN_NUDGE_STORAGE_KEY,
} from "../../../domain/auth-ui";
import { BoardHeader, Button, Dock, EmptyState, Hint, cx } from "../../../ui";
import { useAuth } from "../../auth/AuthProvider";
import { You } from "../../auth/You";
import { AddSheet, boardQueryKey, type PhotoMemory } from "./AddSheet";
import { createPhotoMemory } from "./photo-memory";
import { MakeSheet } from "./MakeSheet";
import { BoardScenes, type PrintSlot, type SceneSlot } from "./BoardScenes";
import { BoardThings } from "./BoardThings";
import { BoardLeftovers } from "./Leftovers";
import { leftoversOf } from "../../../domain/leftovers";
import { JoinSheet } from "./JoinSheet";
import { PlusFlow, useLookFlow } from "./PlusFlow";
import { SceneViewer } from "./SceneViewer";
import styles from "./board.module.css";

export interface BoardClientView extends BoardViewLike {
  board: { slug: string; title: string; themeId?: string | null };
  me: { id: string; displayName: string } | null;
  scenes: BoardViewScene[];
  activity: ActivityLine[];
  /** PIN-103: false in the server render (the host cookie is API-path scoped); the first poll says. */
  viewer?: { isHost: boolean };
  /** PIN-103: the board's Plus state, billing mode and Policy price labels. */
  plus?: PlusView;
}

export interface BoardClientPolicy {
  pollIntervalMs: number;
  jobPollIntervalMs: number;
  uploadMaxPx: number;
  uploadJpegQuality: number;
  pinsPerScene: { min: number; max: number };
  sceneChips: string[];
  scenePromptMaxChars: number;
  /** Policy sceneSize (PIN-129): the print shape of a scene with no stored size. */
  sceneSize: string;
  /** Policy elementsPerPhoto.max, tap-adds included (PIN-78). */
  elementsPerPhotoMax: number;
  /** Policy signInNudge (PIN-84). */
  signInNudge: boolean;
  /** Policy libraryStripMax: the Add sheet's "From your other boards" cap (PIN-121). */
  libraryStripMax: number;
  /** Policy dictation (PIN-119): clip cap; enabled = caps + AI budget on. */
  dictationMaxSeconds: number;
  dictationEnabled: boolean;
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
  | { kind: "edit" };

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
}: {
  slug: string;
  initialView: BoardClientView;
  policy: BoardClientPolicy;
  /** `?tryon=<skin>`: the host's Plus try-on from the start flow (PIN-111). */
  tryOnSkin?: SkinId | null;
  /** `?scene=<id>`: the scene viewer opens on it (PIN-131). */
  initialSceneId?: string | null;
}) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: true } },
      }),
  );
  return (
    <QueryClientProvider client={queryClient}>
      <BoardBody slug={slug} initialView={initialView} policy={policy} tryOnSkin={tryOnSkin} initialSceneId={initialSceneId} />
    </QueryClientProvider>
  );
}

function BoardBody({
  slug,
  initialView,
  policy,
  tryOnSkin,
  initialSceneId,
}: {
  slug: string;
  initialView: BoardClientView;
  policy: BoardClientPolicy;
  tryOnSkin: SkinId | null;
  initialSceneId: string | null;
}) {
  const queryClient = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  // PIN-122: "Pin them" reopens the Add sheet at this photo's review;
  // the last photo's local preview survives sheet closes meanwhile.
  const [resumeJobId, setResumeJobId] = useState<string | null>(null);
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
  // While true, the entry is the one we pushed, so closing goes Back.
  const viewerPushed = useRef(false);
  // Runs once that entry has popped (Remix scrolls the board after it).
  const afterViewer = useRef<(() => void) | null>(null);
  // The print whose picture takes focus back when the viewer closes.
  const viewerReturnId = useRef(initialSceneId);
  useEffect(() => {
    const onPop = () => {
      viewerPushed.current = false;
      setViewerId(sceneIdInUrl(window.location.href));
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
      if (!response.ok) throw new Error("load failed");
      return (await response.json()) as BoardClientView;
    },
    initialData: initialView,
    refetchInterval: policy.pollIntervalMs,
    refetchIntervalInBackground: false,
  });
  const view = boardQuery.data;

  // PIN-111: the board's skin (first-generation theme ids map onto a
  // free skin) and the host's Change look / try-on / Board Plus flow.
  const boardSkin = skinForTheme(view.board.themeId);
  const isHost = view.viewer?.isHost === true;
  const look = useLookFlow({ slug, boardSkin, isHost, plus: view.plus, tryOnParam: tryOnSkin });

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

  useEffect(() => {
    setSelected((current) => {
      const pruned = pruneSelection(current, selectableIds);
      return pruned.size === current.size ? current : pruned;
    });
    // selectableIds identity changes per render; key on its content.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        error?: string;
      };
      if (!response.ok || !data.scene) {
        throw new Error(data.error || t("en", "board.sceneFailed"));
      }
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
      setAttemptError(cause instanceof Error ? cause.message : t("en", "board.sceneFailed")),
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
      if (!response.ok) throw new Error(t("en", "board.deleteFailed"));
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

  // Poll my in-flight scene at job cadence so the strip's print
  // lands faster than the board poll; both share the TanStack
  // cache and the poll stops at a terminal status.
  const attemptInView = attempt
    ? view.scenes.find((scene) => scene.id === attempt.sceneId)
    : undefined;
  const scenePoll = useQuery({
    queryKey: ["board-scene", slug, liveSceneId],
    queryFn: async (): Promise<{ scene: BoardViewScene }> => {
      const response = await fetch(
        `/api/boards/${encodeURIComponent(slug)}/scenes/${encodeURIComponent(liveSceneId ?? "")}`,
        { cache: "no-store" },
      );
      const data = (await response.json()) as { scene?: BoardViewScene; error?: string };
      if (!response.ok || !data.scene) throw new Error(data.error || t("en", "board.sceneFailed"));
      return { scene: data.scene };
    },
    enabled:
      liveSceneId !== null &&
      attempt?.sceneId === liveSceneId &&
      !makeScene.isPending &&
      !(attemptInView && isTerminalScene(attemptInView.status)),
    refetchInterval: (query) =>
      query.state.data && isTerminalScene(query.state.data.scene.status)
        ? false
        : policy.jobPollIntervalMs,
  });
  const polledScene = scenePoll.data?.scene;
  const polledStatus = polledScene?.status;
  useEffect(() => {
    if (polledStatus && isTerminalScene(polledStatus)) {
      void queryClient.invalidateQueries({ queryKey: boardQueryKey(slug) });
    }
  }, [polledStatus, queryClient, slug]);

  const scenes = scenesNewestFirst(
    polledScene
      ? [polledScene, ...view.scenes.filter((scene) => scene.id !== polledScene.id)]
      : view.scenes,
  );
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  function runIntent(intent: JoinIntent) {
    if (intent.kind === "add") {
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
    ? tf("en", `activity.${latest.kind}` as const, {
        name: latest.name ?? t("en", "board.someone"),
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
      slots.push({
        type: "problem",
        ratio: slotRatio,
        id: scene.id,
        idea: scene.prompt,
        line: refused ? (scene.refusalReason ?? t("en", "ai.refused")) : t("en", "board.sceneFailed"),
        onChangeIdea: changeIdea,
        // A refusal repeats for the same idea: only a new idea helps.
        onTryAgain: refused ? undefined : tryAgain,
      });
    } else if (scene.imageUrl) {
      const credits = sceneCredits(scene, view.elements, view.participants, view.scenes);
      const things = credits
        .map((credit) =>
          credit.owner ? tf("en", "ui.ownerThing", { owner: credit.owner.name, thing: credit.thing }) : credit.thing,
        )
        .join(", ");
      slots.push({
        type: "print",
        ratio: sceneRatio(scene, policy.sceneSize),
        id: scene.id,
        src: scene.imageUrl,
        alt: things ? tf("en", "board.sceneAlt", { idea: scene.prompt, things }) : scene.prompt,
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
              {t("en", "share.failed")}
            </p>
          ) : null,
      });
    }
  }

  const viewerSlot = slots.find((slot): slot is PrintSlot => slot.type === "print" && slot.id === viewerId);
  const viewerOpen = viewerSlot !== undefined;
  // An unknown, hidden or deleted scene: the board with one quiet line,
  // and no `?scene=` left for Back to reopen.
  useEffect(() => {
    if (viewerId === null || viewerIds.includes(viewerId)) return;
    viewerReturnId.current = null;
    setSceneMissing(true);
    closeViewer();
    // viewerIds' content is keyed by its join; closeViewer reads refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewerId, viewerIds.join(",")]);
  useEffect(() => {
    const id = viewerReturnId.current;
    if (viewerOpen || !id) return;
    viewerReturnId.current = null;
    document.querySelector<HTMLElement>(`[data-scene-id="${CSS.escape(id)}"] .pn-print-open`)?.focus();
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

  return (
    <div className="pn-skin-root" data-theme={look.shownSkin} style={{ minHeight: "100dvh" }}>
      <main className={cx(styles.board, !showDock && styles.boardRest, look.tryOn && styles.boardTryOn)} inert={viewerOpen}>
        <BoardHeader
          title={view.board.title}
          people={people}
          peopleLabel={tf("en", "you.alsoHere", { names: people.map((p) => p.name).join(", ") })}
          counts={counts}
          onShare={() => void shareBoard()}
          homeHref="/"
          you={
            <You
              board={{
                me: view.me,
                isHost,
                onJoin: () => setJoinIntent({ kind: "join" }),
                onEditName: () => setJoinIntent({ kind: "edit" }),
                onChangeLook: look.openLook,
              }}
            />
          }
        />

        <div className={styles.under}>
          {latestLine && !pickingNow ? (
            <p className={cx("pn-board-meta", styles.latest)}>
              <span className="pn-sr">{t("en", "board.activity")}: </span>
              {latestLine}
            </p>
          ) : null}
          {sceneMissing ? (
            <p className="pn-board-meta" role="status">
              {t("en", "board.sceneMissing")}
            </p>
          ) : null}
          {shareNotice ? (
            <p className={shareNotice === "copied" ? styles.notice : styles.error} role="status">
              {shareNotice === "copied" ? t("en", "share.copied") : t("en", "share.copyFailed")}
            </p>
          ) : null}
          {boardQuery.isError ? (
            <div className={styles.errorRow}>
              <p className={styles.error} role="alert">
                {t("en", "board.loadError")}
              </p>
              <Button size="sm" onClick={() => void boardQuery.refetch()}>
                {t("en", "board.retry")}
              </Button>
            </div>
          ) : null}
          {showNudge ? (
            <div className={styles.nudge} role="status">
              <p>{t("en", "auth.nudge")}</p>
              <div className={styles.nudgeActions}>
                <Button
                  size="sm"
                  onClick={() => {
                    dismissNudge();
                    void auth.signIn();
                  }}
                >
                  {t("en", "auth.signIn")}
                </Button>
                <Button variant="quiet" size="sm" onClick={dismissNudge}>
                  {t("en", "auth.nudgeDismiss")}
                </Button>
              </div>
            </div>
          ) : null}
        </div>

        {pickingNow ? (
          <div className={styles.hintRow}>
            {remixParent ? (
              <Hint onDismiss={exitPicking} dismissLabel={t("en", "board.stop")} x={40}>
                {tf("en", "board.remixing", { idea: remixParent.prompt })}
              </Hint>
            ) : !pickHintSeen ? (
              <Hint onDismiss={dismissPickHint} x={40}>
                {tCount("en", "board.pickHint", policy.pinsPerScene.max)}
              </Hint>
            ) : atMax ? (
              <p className="pn-board-meta" role="status">
                {tf("en", "board.pickMax", { n: policy.pinsPerScene.max })}
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
              setResumeJobId(group.jobId);
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
            onTapPin={(pinId) => requireJoin({ kind: "pick", pinId })}
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
            key={resumeJobId ?? "new"}
            slug={slug}
            meId={view.me.id}
            boardView={view}
            uploadMaxPx={policy.uploadMaxPx}
            uploadJpegQuality={policy.uploadJpegQuality}
            jobPollIntervalMs={policy.jobPollIntervalMs}
            elementsPerPhotoMax={policy.elementsPerPhotoMax}
            libraryStripMax={policy.libraryStripMax}
            resumeJobId={resumeJobId}
            photoMemory={photoMemory}
            onClose={() => {
              setAddOpen(false);
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
                    imageUrl: remixParent.imageUrl,
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

        {isHost ? (
          <PlusFlow
            look={look}
            boardSkin={boardSkin}
            plus={view.plus}
            sample={lookSampleUrls}
            foilSrc={lookSampleUrls[0]}
            aboveDock={showDock}
            picking={pickingNow}
          />
        ) : null}
      </main>
      {viewerSlot ? (
        <SceneViewer
          slot={viewerSlot}
          onClose={() => closeViewer()}
          onStep={stepViewer}
          onRemix={viewerSlot.onRemix ? () => closeViewer(viewerSlot.onRemix) : undefined}
        />
      ) : null}
    </div>
  );
}
