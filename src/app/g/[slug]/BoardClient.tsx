"use client";

import { useEffect, useState, type FormEvent } from "react";
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { needsEmptyPrompt, pinCards, type BoardViewLike } from "../../../domain/board-view";
import { playerColorFor } from "../../../domain/board-themes";
import { t } from "../../../i18n";
import { AddSheet, boardQueryKey } from "./AddSheet";

export interface BoardClientView extends BoardViewLike {
  board: { slug: string; title: string };
  me: { id: string; displayName: string } | null;
  scenes: { id: string }[];
}

export interface BoardClientPolicy {
  pollIntervalMs: number;
  jobPollIntervalMs: number;
  uploadMaxPx: number;
  uploadJpegQuality: number;
}

/**
 * Studio board (PIN-66/67, docs/11 sections 5.8 + 6): scenes
 * placeholder on top, pins grid with owner names, fixed bottom
 * bar. TanStack Query polls the board view (Policy cadence,
 * refetch on focus) so a second phone sees new pins; the Add
 * sheet owns uploads and optimistic pins.
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
  const [sheetOpen, setSheetOpen] = useState(false);
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
  const empty = needsEmptyPrompt(view);

  return (
    <>
      <section className="card" aria-label={t("en", "board.scenes")}>
        <h2>{t("en", "board.scenes")}</h2>
        <p className="board-placeholder">{t("en", "board.scenesEmpty")}</p>
      </section>

      <JoinSection slug={slug} me={view.me} onJoined={handleJoined} />

      <section aria-label={t("en", "board.pins")}>
        <h2>{t("en", "board.pins")}</h2>
        {empty ? (
          <div className="card board-empty">
            <p className="board-empty-prompt">{t("en", "board.emptyPrompt")}</p>
            <p>{t("en", "board.emptyBody")}</p>
          </div>
        ) : null}
        {cards.length > 0 ? (
          <ul className="pins-grid">
            {cards.map((card) => (
              <li key={card.pinId} className="pin-card">
                {/* eslint-disable-next-line @next/next/no-img-element -- board-link-checked API image */}
                <img src={card.element.imageUrl} alt={card.element.label} loading="lazy" />
                <p className="pin-label">{card.element.label}</p>
                <p className="pin-owner">
                  <span
                    className="chip-dot"
                    style={{ background: playerColorFor(card.ownerId) }}
                    aria-hidden="true"
                  />{" "}
                  {card.ownerName ?? t("en", "board.someone")}
                </p>
                {card.status === "candidate" ? (
                  <p className="state-pill">{t("en", "board.candidate")}</p>
                ) : null}
              </li>
            ))}
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
          <button type="button" className="btn btn-primary" onClick={() => setSheetOpen(true)}>
            {t("en", "board.add")}
          </button>
        ) : (
          <a className="btn btn-primary" href="#join">
            {t("en", "board.add")}
          </a>
        )}
        <button type="button" className="btn" disabled title={t("en", "board.soon")}>
          {t("en", "board.make")}
        </button>
      </nav>

      {sheetOpen && view.me ? (
        <AddSheet
          slug={slug}
          meId={view.me.id}
          boardView={view}
          uploadMaxPx={policy.uploadMaxPx}
          uploadJpegQuality={policy.uploadJpegQuality}
          jobPollIntervalMs={policy.jobPollIntervalMs}
          onClose={() => setSheetOpen(false)}
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
