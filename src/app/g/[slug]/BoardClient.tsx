"use client";

import { useEffect, useState, type FormEvent } from "react";
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
  sceneCreditParts,
  scenesNewestFirst,
  selectableCards,
  selectedCards,
  togglePinSelection,
  chipsForSelection,
  chipsSelectionKey,
} from "../../../domain/make-sheet";
import { chooseShareAction, sceneShareFilename } from "../../../domain/board-preview";
import type { ActivityLine } from "../../../domain/board-activity";
import { playerColorFor } from "../../../domain/board-themes";
import { t } from "../../../i18n";
import { AddSheet, boardQueryKey } from "./AddSheet";
import { MakeSheet } from "./MakeSheet";

export interface BoardClientView extends BoardViewLike {
  board: { slug: string; title: string };
  me: { id: string; displayName: string } | null;
  scenes: BoardViewScene[];
  activity: ActivityLine[];
}

export interface BoardClientPolicy {
  pollIntervalMs: number;
  jobPollIntervalMs: number;
  uploadMaxPx: number;
  uploadJpegQuality: number;
  pinsPerScene: { min: number; max: number };
  sceneChips: string[];
  scenePromptMaxChars: number;
}

interface SceneAttempt {
  sceneId: string;
  elementIds: string[];
  prompt: string;
  pinIds: string[];
}

function newSceneId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `scene-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Studio board (PIN-66/67/70, docs/11 section 6): scenes first,
 * pins grid with owner names, fixed bottom bar. TanStack Query
 * polls the board view (Policy cadence) so a second phone sees
 * new pins and scenes. Picking up to Policy.pinsPerScene.max pins
 * (count in the bottom bar) opens the Make sheet; "Make it ✨"
 * closes it and a cooking card polls the scene in the gallery.
 */
export function BoardClient({
  slug,
  initialView,
  policy,
}: {
  slug: string;
  initialView: BoardClientView;
  policy: BoardClientPolicy;
}) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: true } },
      }),
  );
  return (
    <QueryClientProvider client={queryClient}>
      <BoardBody slug={slug} initialView={initialView} policy={policy} />
    </QueryClientProvider>
  );
}

function BoardBody({
  slug,
  initialView,
  policy,
}: {
  slug: string;
  initialView: BoardClientView;
  policy: BoardClientPolicy;
}) {
  const queryClient = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  const [makeOpen, setMakeOpen] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [attempt, setAttempt] = useState<SceneAttempt | null>(null);
  const [attemptError, setAttemptError] = useState("");
  // Set only when a POST actually created the scene — polling a
  // client id that a 400/429 rejected would 404 forever.
  const [liveSceneId, setLiveSceneId] = useState<string | null>(null);
  // Sheet prompt seed: "" for a fresh scene; the refused/failed
  // attempt's prompt only via "Change idea".
  const [sheetPrompt, setSheetPrompt] = useState("");
  // PIN-75: generated chips, keyed by the selection they were made for.
  const [generatedChips, setGeneratedChips] = useState<{ key: string; chips: string[] } | null>(null);
  const [sharingSceneId, setSharingSceneId] = useState<string | null>(null);
  const [shareErrorSceneId, setShareErrorSceneId] = useState<string | null>(null);
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
          }),
        },
      );
      const data = (await response.json()) as {
        scene?: BoardViewScene;
        error?: string;
      };
      if (!response.ok || !data.scene) {
        throw new Error(data.error || t("en", "make.failed"));
      }
      return data.scene;
    },
    onSuccess: (scene) => {
      // The picks are spent. Merge the POST's scene straight into
      // the board cache so the cooking card hands over to the real
      // card with no empty poll gap, then let polls reconcile.
      setSelected(new Set());
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
      setAttemptError(cause instanceof Error ? cause.message : t("en", "make.failed")),
  });

  // Poll my in-flight scene at job cadence so the gallery card
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
      if (!response.ok || !data.scene) throw new Error(data.error || t("en", "make.failed"));
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
  const showCooking =
    makeScene.isPending &&
    !(attempt && scenes.some((scene) => scene.id === attempt.sceneId));
  const picked = selectedCards(cards, selected);
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
  const empty = needsEmptyPrompt(view);

  function togglePin(pinId: string) {
    // Functional update: fast successive taps must each see the
    // previous pick, not the render-time snapshot.
    setSelected(
      (current) => togglePinSelection(current, pinId, policy.pinsPerScene.max).next,
    );
  }

  function submitScene(input: { elementIds: string[]; prompt: string; pinIds: string[] }) {
    // A fresh sceneId per Make-it press; the network retry below
    // reuses it, which the server treats idempotently (PIN-69).
    const sceneAttempt: SceneAttempt = { ...input, sceneId: newSceneId() };
    setAttempt(sceneAttempt);
    setAttemptError("");
    setLiveSceneId(null);
    setMakeOpen(false);
    makeScene.mutate(sceneAttempt);
  }

  function retryScene() {
    if (!attempt) return;
    setAttemptError("");
    makeScene.mutate(attempt);
  }

  function changeIdea() {
    if (!attempt) return;
    setSelected(pruneSelection(new Set(attempt.pinIds), selectableIds));
    setSheetPrompt(attempt.prompt);
    setMakeOpen(true);
  }

  function openMakeSheet() {
    setSheetPrompt("");
    setMakeOpen(true);
  }

  // PIN-72: share the scene image file when the browser can,
  // else the board link, else download. A user-cancelled sheet
  // (AbortError) is silent; success is never claimed in the UI.
  async function shareScene(scene: BoardViewScene) {
    if (!scene.imageUrl || sharingSceneId) return;
    setSharingSceneId(scene.id);
    setShareErrorSceneId(null);
    const pageUrl = window.location.href.split("#")[0] ?? window.location.href;
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
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      if (cause instanceof Error && cause.name === "AbortError") return;
      setShareErrorSceneId(scene.id);
    } finally {
      setSharingSceneId(null);
    }
  }

  function renderScene(scene: BoardViewScene) {
    const parts = sceneCreditParts(scene, view.elements, view.participants);
    const mine = attempt !== null && scene.id === attempt.sceneId;
    return (
      <li key={scene.id} className="scene-card">
        {scene.status === "ready" && scene.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- board-link-checked API image
          <img src={scene.imageUrl} alt={scene.prompt} loading="lazy" />
        ) : scene.status === "refused" ? (
          <p role="status">{scene.refusalReason ?? t("en", "ai.refused")}</p>
        ) : scene.status === "failed" ? (
          <p role="status">{t("en", "make.failed")}</p>
        ) : (
          <p role="status">{t("en", "make.cooking")}</p>
        )}
        {scene.status === "ready" && scene.kind === "collage" ? (
          <p className="state-pill">{t("en", "make.collage")}</p>
        ) : null}
        <p className="scene-prompt">{scene.prompt}</p>
        {parts.length > 0 ? (
          <p className="scene-credit">
            {t("en", "make.from")}{" "}
            {parts
              .map((part) => (part.ownerName ? `${part.ownerName}'s ${part.label}` : part.label))
              .join(" + ")}
          </p>
        ) : null}
        {scene.status === "ready" && scene.imageUrl ? (
          <button
            type="button"
            className="btn btn-small"
            disabled={sharingSceneId === scene.id}
            onClick={() => void shareScene(scene)}
          >
            {sharingSceneId === scene.id ? t("en", "share.sharing") : t("en", "share.button")}
          </button>
        ) : null}
        {shareErrorSceneId === scene.id ? (
          <p className="error" role="alert">{t("en", "share.failed")}</p>
        ) : null}
        {mine && (scene.status === "refused" || scene.status === "failed") ? (
          <button type="button" className="btn btn-small" onClick={changeIdea}>
            {t("en", "make.changeIdea")}
          </button>
        ) : null}
      </li>
    );
  }

  return (
    <>
      <section className="card" aria-label={t("en", "board.scenes")}>
        <h2>{t("en", "board.scenes")}</h2>
        {showCooking ? (
          <p className="scene-card" role="status">
            {t("en", "make.cooking")}
            {attempt ? <span className="scene-prompt"> {attempt.prompt}</span> : null}
          </p>
        ) : null}
        {attemptError ? (
          <p className="error" role="alert">
            {attemptError}{" "}
            <button type="button" className="btn btn-small" onClick={retryScene}>
              {t("en", "admin.retry")}
            </button>
          </p>
        ) : null}
        {scenes.length > 0 ? (
          <ul className="scene-list">{scenes.map(renderScene)}</ul>
        ) : !showCooking ? (
          <p className="board-placeholder">{t("en", "board.scenesEmpty")}</p>
        ) : null}
      </section>

      {view.activity.length > 0 ? (
        <section className="card" aria-label={t("en", "board.activity")}>
          <h2>{t("en", "board.activity")}</h2>
          <ul className="activity-list">
            {view.activity.map((line) => (
              <li key={line.id}>
                {line.actorName ?? t("en", "board.someone")}{" "}
                {line.kind === "joined"
                  ? t("en", "activity.joined")
                  : line.kind === "pinned"
                    ? t("en", "activity.pinned")
                    : t("en", "activity.sceneReady")}
                {line.label ? <> {line.label}</> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <JoinSection slug={slug} me={view.me} onJoined={handleJoined} />

      <section aria-label={t("en", "board.pins")}>
        <h2>{t("en", "board.pins")}</h2>
        {empty ? (
          <div className="card board-empty">
            <p className="board-empty-prompt">{t("en", "board.emptyPrompt")}</p>
            <p>{t("en", "board.emptyBody")}</p>
          </div>
        ) : null}
        {selectableIds.length > 0 && selected.size === 0 ? (
          <p className="hint" role="status">{t("en", "make.pickHint")}</p>
        ) : null}
        {selected.size >= policy.pinsPerScene.max ? (
          <p className="hint" role="status">
            {policy.pinsPerScene.max} {t("en", "make.max")}
          </p>
        ) : null}
        {cards.length > 0 ? (
          <ul className="pins-grid">
            {cards.map((card) => {
              const owner = (
                <>
                  <span
                    className="chip-dot"
                    style={{ background: playerColorFor(card.ownerId) }}
                    aria-hidden="true"
                  />{" "}
                  {card.ownerName ?? t("en", "board.someone")}
                </>
              );
              if (card.status !== "pinned") {
                return (
                  <li key={card.pinId} className="pin-card">
                    {/* eslint-disable-next-line @next/next/no-img-element -- board-link-checked API image */}
                    <img src={card.element.imageUrl} alt={card.element.label} loading="lazy" />
                    <p className="pin-label">{card.element.label}</p>
                    <p className="pin-owner">{owner}</p>
                    <p className="state-pill">{t("en", "board.candidate")}</p>
                  </li>
                );
              }
              const picking = selected.has(card.pinId);
              return (
                <li key={card.pinId}>
                  <button
                    type="button"
                    className={`pin-card pin-toggle${picking ? " pin-selected" : ""}`}
                    aria-pressed={picking}
                    onClick={() => togglePin(card.pinId)}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element -- board-link-checked API image */}
                    <img src={card.element.imageUrl} alt={card.element.label} loading="lazy" />
                    <span className="pin-label">{card.element.label}</span>
                    <span className="pin-owner">{owner}</span>
                    {picking ? <span className="state-pill">{t("en", "make.picked")}</span> : null}
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}
        {boardQuery.isError ? (
          <p className="error" role="alert">
            {t("en", "board.loadError")}{" "}
            <button type="button" className="btn btn-small" onClick={() => void boardQuery.refetch()}>
              {t("en", "admin.retry")}
            </button>
          </p>
        ) : null}
      </section>

      <nav className="bottom-bar" aria-label={t("en", "board.pins")}>
        {view.me ? (
          <button type="button" className="btn btn-primary" onClick={() => setAddOpen(true)}>
            {t("en", "board.add")}
          </button>
        ) : (
          <a className="btn btn-primary" href="#join">
            {t("en", "board.add")}
          </a>
        )}
        {view.me ? (
          <button
            type="button"
            className="btn"
            disabled={selected.size < policy.pinsPerScene.min}
            onClick={openMakeSheet}
          >
            {`${t("en", "board.make")} ${selected.size}/${policy.pinsPerScene.max}`}
          </button>
        ) : (
          <a className="btn" href="#join">
            {`${t("en", "board.make")} ${selected.size}/${policy.pinsPerScene.max}`}
          </a>
        )}
      </nav>

      {addOpen && view.me ? (
        <AddSheet
          slug={slug}
          meId={view.me.id}
          boardView={view}
          uploadMaxPx={policy.uploadMaxPx}
          uploadJpegQuality={policy.uploadJpegQuality}
          jobPollIntervalMs={policy.jobPollIntervalMs}
          onClose={() => setAddOpen(false)}
        />
      ) : null}

      {makeOpen && view.me ? (
        <MakeSheet
          cards={picked}
          chips={sheetChips}
          pinsPerScene={policy.pinsPerScene}
          promptMaxChars={policy.scenePromptMaxChars}
          initialPrompt={sheetPrompt}
          onMake={submitScene}
          onClose={() => setMakeOpen(false)}
        />
      ) : null}
    </>
  );
}

function JoinSection({
  slug,
  me,
  onJoined,
}: {
  slug: string;
  me: { id: string; displayName: string } | null;
  onJoined: (participant: { id: string; displayName: string }) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [displayName, setDisplayName] = useState(me?.displayName ?? "");
  const [reclaimPin, setReclaimPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (me && !editing) setDisplayName(me.displayName);
  }, [me, editing]);

  if (me && !editing) {
    return (
      <section className="card player-card" id="join">
        <span className="player-avatar" style={{ background: playerColorFor(me.id) }} aria-hidden="true">
          {([...me.displayName][0] ?? "").toUpperCase()}
        </span>
        <p className="who">
          <strong>{me.displayName}</strong>
          {t("en", "join.ready")}
        </p>
        <button type="button" className="btn btn-small" onClick={() => setEditing(true)}>
          {t("en", "join.edit")}
        </button>
      </section>
    );
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/boards/${encodeURIComponent(slug)}/participants`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName, reclaimPin: reclaimPin || undefined }),
      });
      const data = (await response.json()) as {
        participant?: { id: string; displayName: string };
        error?: string;
      };
      if (!response.ok || !data.participant) throw new Error(data.error || t("en", "join.error"));
      setReclaimPin("");
      setEditing(false);
      onJoined(data.participant);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("en", "join.error"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" id="join" onSubmit={onSubmit}>
      <h2>{t("en", "join.title")}</h2>
      {!me ? <p className="hint" role="status">{t("en", "board.joinFirst")}</p> : null}
      <div className="field">
        <label htmlFor="join-name">{t("en", "join.name")}</label>
        <input
          id="join-name"
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          placeholder={t("en", "join.namePlaceholder")}
          autoComplete="nickname"
          required
        />
      </div>
      <details className="field">
        <summary>{t("en", "join.pinSummary")}</summary>
        <label htmlFor="reclaim-pin">{t("en", "join.pin")}</label>
        <input
          id="reclaim-pin"
          value={reclaimPin}
          onChange={(event) => setReclaimPin(event.target.value.replace(/\D/g, "").slice(0, 4))}
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="1234"
        />
        <p className="field-help">{t("en", "join.pinHelp")}</p>
      </details>
      {error ? <p className="error" role="alert">{error}</p> : null}
      <button className="btn btn-primary" type="submit" disabled={busy || !displayName.trim()}>
        {busy ? t("en", "join.saving") : me ? t("en", "join.update") : t("en", "join.submit")}
      </button>
    </form>
  );
}
