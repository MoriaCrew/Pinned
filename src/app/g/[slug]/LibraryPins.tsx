"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { familyOf, libraryLoadStatus, type LibraryPinState, type LibraryStripView } from "../../../domain/library-strip";
import type { MyPinCard } from "../../../domain/my-pins";
import { t, tf } from "../../../i18n";
import { Button, Icon, Sticker } from "../../../ui";
import { boardQueryKey } from "./AddSheet";

export interface MyPinsResponse {
  elements: MyPinCard[];
  total: number;
  limit: number;
}

/** What a library thing's pin action says in each state. */
export function libraryPinLabel(state: LibraryPinState): string {
  switch (state) {
    case "pinning":
      return t("en", "add.libraryPinning");
    case "pinned":
      return t("en", "add.libraryPinned");
    case "already":
      return t("en", "add.libraryAlready");
    case "failed":
      return t("en", "add.libraryRetry");
    default:
      return t("en", "add.libraryPin");
  }
}

/**
 * The library with the copy a pin just made, added at the end so the
 * original stays the family's sticker. Same family as `card`, labelled
 * with this board's title; no-op when that element is already listed.
 */
export function withLibraryCopy(
  library: MyPinsResponse,
  card: MyPinCard,
  copyId: string,
  boardTitle: string,
): MyPinsResponse {
  if (library.elements.some((item) => item.elementId === copyId)) return library;
  const copy: MyPinCard = { ...card, elementId: copyId, familyId: familyOf(card), sourceBoardTitle: boardTitle };
  return { ...library, elements: [...library.elements, copy], total: library.total + 1 };
}

/** In flight or already on the board: a tap does nothing. */
const isInert = (state: LibraryPinState) => state === "pinning" || state === "pinned" || state === "already";

/**
 * The signed-in user's library (GET /api/me/elements) and the
 * pin-to-this-board call (PIN-85), shared by the Add sheet's strip
 * and its "See all" list so both show the same per-thing state.
 * Pinning posts to this board's from-library route and invalidates
 * the board query, so the new pin pops into the grid behind the
 * sheet, and the library, which then holds the new copy (its family
 * reads "Already here" from then on, also after the sheet reopens).
 * A repeat pin reads back as the friendly "Already here". State is
 * kept per family, so every row of the same thing follows the tap.
 * Disabled (signed out or sign-in off) it never fetches.
 */
export function useLibraryPins(slug: string, enabled: boolean, boardTitle: string) {
  const queryClient = useQueryClient();
  const [states, setStates] = useState<ReadonlyMap<string, LibraryPinState>>(new Map());

  const library = useQuery({
    queryKey: ["my-pins"],
    queryFn: async (): Promise<MyPinsResponse> => {
      const response = await fetch("/api/me/elements", { cache: "no-store" });
      const data = (await response.json()) as MyPinsResponse & { error?: string };
      if (!response.ok) throw new Error(data.error || t("en", "add.libraryFailed"));
      return data;
    },
    enabled,
  });

  const setState = (card: MyPinCard, value: LibraryPinState) =>
    setStates((current) => new Map(current).set(familyOf(card), value));

  const pin = useMutation({
    mutationFn: async (card: MyPinCard) => {
      const response = await fetch(`/api/boards/${encodeURIComponent(slug)}/pins/from-library`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ elementId: card.elementId }),
      });
      const data = (await response.json()) as { alreadyPinned?: boolean; elementId?: string; error?: string };
      if (!response.ok) throw new Error(data.error || t("en", "add.pinFailed"));
      return data;
    },
    // Options-level callbacks run for every tap, so several stickers
    // can be in flight at once.
    onMutate: (card) => setState(card, "pinning"),
    onSuccess: (data, card) => {
      setState(card, data.alreadyPinned ? "already" : "pinned");
      // Put the copy in the cached library right away, so its family
      // reads "Already here" even if the sheet closes and reopens
      // before the library refetch lands (it walks every board).
      if (data.elementId) {
        queryClient.setQueryData<MyPinsResponse>(["my-pins"], (current) =>
          current ? withLibraryCopy(current, card, data.elementId as string, boardTitle) : current,
        );
      }
      void queryClient.invalidateQueries({ queryKey: boardQueryKey(slug) });
      void queryClient.invalidateQueries({ queryKey: ["my-pins"] });
    },
    onError: (_cause, card) => setState(card, "failed"),
  });

  return {
    status: libraryLoadStatus(library.status, library.data !== undefined),
    cards: library.data?.elements,
    states,
    pin: (card: MyPinCard) => pin.mutate(card),
    retry: () => void library.refetch(),
  };
}

/** A load error: one line and its one way out. */
function LibraryProblem({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="pn-add-lib-state">
      <p className="pn-add-line pn-add-line-error" role="alert">
        <Icon name="info" size={18} />
        <span>{t("en", "add.libraryFailed")}</span>
      </p>
      <Button size="sm" icon="undo" onClick={onRetry}>
        {t("en", "add.libraryRetry")}
      </Button>
    </div>
  );
}

/**
 * "From your other boards" (PIN-121): under the photo target, a
 * strip of the user's stickers from their other boards; one tap
 * pins that thing here. Loading shows sticker-shaped placeholders
 * (they pulse unless motion is reduced), a load error is one line
 * and Try again. The sheet hides the whole section when the view
 * is "hidden" (signed out, sign-in off, nothing from other boards).
 */
export function LibraryStrip({
  view,
  headingId,
  seeAllId,
  onPin,
  onSeeAll,
  onRetry,
}: {
  view: Exclude<LibraryStripView, { kind: "hidden" }>;
  headingId: string;
  /** Id of "See all", so the sheet can put focus back on it after Back. */
  seeAllId?: string;
  onPin: (card: MyPinCard) => void;
  onSeeAll: () => void;
  onRetry: () => void;
}) {
  return (
    <section className="pn-add-strip" aria-labelledby={headingId}>
      <div className="pn-add-strip-head">
        <h3 className="pn-add-strip-title" id={headingId}>
          {t("en", "add.stripTitle")}
        </h3>
        {view.kind === "items" ? (
          <Button variant="quiet" size="sm" className="pn-add-strip-all" id={seeAllId} onClick={onSeeAll}>
            {t("en", "add.seeAll")}
          </Button>
        ) : null}
      </div>
      {view.kind === "loading" ? (
        <>
          <ul className="pn-add-strip-list" aria-hidden="true">
            {Array.from({ length: view.placeholders }, (_, index) => (
              <li key={index} className="pn-add-strip-ghost">
                <span className="pn-add-strip-ghost-sticker" />
                <span className="pn-add-strip-ghost-tag" />
              </li>
            ))}
          </ul>
          <p className="pn-sr" role="status">
            {t("en", "add.libraryLoading")}
          </p>
        </>
      ) : null}
      {view.kind === "error" ? <LibraryProblem onRetry={onRetry} /> : null}
      {view.kind === "items" ? (
        <ul className="pn-add-strip-list">
          {view.items.map(({ card, state }) => {
            const spoken = `${libraryPinLabel(state)}: ${card.label}`;
            return (
              <li key={card.elementId}>
                <button
                  type="button"
                  className="pn-add-strip-item"
                  data-state={state}
                  aria-label={spoken}
                  aria-disabled={isInert(state) || undefined}
                  onClick={() => {
                    if (!isInert(state)) onPin(card);
                  }}
                >
                  <span className="pn-add-strip-sticker">
                    <Sticker
                      src={card.imageUrl}
                      seed={card.elementId}
                      size={72}
                      state={state === "already" ? "dropped" : "rest"}
                    />
                    {state === "pinned" ? (
                      <span className="pn-add-strip-check" aria-hidden="true">
                        <Icon name="check" size={16} strokeWidth={3} />
                      </span>
                    ) : null}
                  </span>
                  {state === "idle" ? (
                    <span className="pn-pin-tag">
                      <span className="pn-pin-tag-text">{card.label}</span>
                    </span>
                  ) : (
                    <span className="pn-add-strip-status">
                      {state === "failed" ? <Icon name="undo" size={14} /> : null}
                      {libraryPinLabel(state)}
                    </span>
                  )}
                </button>
                <span className="pn-sr" role="status">
                  {state === "idle" || state === "already" ? "" : spoken}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

/**
 * "See all" (PIN-85 list, kept from the old "From my pins" tab):
 * every library thing as a sticker row with its source board and a
 * Pin here button; settled rows read "Pinned" or "Already here".
 */
export function LibraryList({
  status,
  cards,
  stateOf,
  onPin,
  onRetry,
}: {
  status: "pending" | "error" | "success";
  cards: readonly MyPinCard[] | undefined;
  stateOf: (card: MyPinCard) => LibraryPinState;
  onPin: (card: MyPinCard) => void;
  onRetry: () => void;
}) {
  if (status === "pending") {
    return (
      <p className="pn-add-line" role="status">
        <Icon name="pin" size={18} />
        <span>{t("en", "add.libraryLoading")}</span>
      </p>
    );
  }
  if (status === "error" || !cards) return <LibraryProblem onRetry={onRetry} />;
  if (cards.length === 0) {
    return (
      <p className="pn-add-line" role="status">
        <Icon name="info" size={18} />
        <span>{t("en", "add.libraryEmpty")}</span>
      </p>
    );
  }

  return (
    <ul className="pn-add-lib">
      {cards.map((card) => {
        const state = stateOf(card);
        const done = state === "pinned" || state === "already";
        return (
          <li key={card.elementId} className="pn-add-lib-row" data-done={done ? "" : undefined}>
            <Sticker src={card.imageUrl} alt="" seed={card.elementId} size={64} />
            <span className="pn-add-lib-text">
              <b>{card.label}</b>
              <span>{tf("en", "add.libraryFrom", { board: card.sourceBoardTitle })}</span>
            </span>
            {done ? (
              <span className="pn-add-lib-done" role="status">
                <Icon name="check" size={18} />
                {libraryPinLabel(state)}
              </span>
            ) : (
              <Button
                size="sm"
                icon={state === "failed" ? "undo" : "pin"}
                disabled={state === "pinning"}
                aria-label={`${libraryPinLabel(state)}: ${card.label}`}
                onClick={() => onPin(card)}
              >
                {libraryPinLabel(state)}
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
