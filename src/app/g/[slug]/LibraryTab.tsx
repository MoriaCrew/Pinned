"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { MyPinCard } from "../../../domain/my-pins";
import { t, tf } from "../../../i18n";
import { Button, Icon, Sticker } from "../../../ui";
import { boardQueryKey } from "./AddSheet";

interface MyPinsResponse {
  elements: MyPinCard[];
  total: number;
  limit: number;
}

type RowState = "idle" | "pinning" | "pinned" | "already" | "failed";

function rowButtonLabel(state: RowState): string {
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
 * "From my pins" Add-sheet tab (PIN-85, restyled in PIN-99): the
 * signed-in user's library (GET /api/me/elements) as sticker rows
 * with a Pin button each. Pinning posts to this board's
 * from-library route and then invalidates the board query, so the
 * new pin pops into the grid behind the sheet; a repeat pin reads
 * back as the friendly already-pinned state. Rendered only for
 * signed-in users — the parent sheet hides the tab otherwise, so
 * the link-only Add flow is untouched.
 */
export function LibraryTab({ slug }: { slug: string }) {
  const queryClient = useQueryClient();
  const [states, setStates] = useState<ReadonlyMap<string, RowState>>(new Map());

  const library = useQuery({
    queryKey: ["my-pins"],
    queryFn: async (): Promise<MyPinsResponse> => {
      const response = await fetch("/api/me/elements", { cache: "no-store" });
      const data = (await response.json()) as MyPinsResponse & { error?: string };
      if (!response.ok) throw new Error(data.error || t("en", "add.libraryFailed"));
      return data;
    },
  });

  const setState = (elementId: string, value: RowState) =>
    setStates((current) => new Map(current).set(elementId, value));

  const pin = useMutation({
    mutationFn: async (elementId: string) => {
      const response = await fetch(
        `/api/boards/${encodeURIComponent(slug)}/pins/from-library`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ elementId }),
        },
      );
      const data = (await response.json()) as {
        alreadyPinned?: boolean;
        error?: string;
      };
      if (!response.ok) throw new Error(data.error || t("en", "add.libraryFailed"));
      return data;
    },
    onMutate: (elementId) => setState(elementId, "pinning"),
    onSuccess: (data, elementId) => {
      setState(elementId, data.alreadyPinned ? "already" : "pinned");
      void queryClient.invalidateQueries({ queryKey: boardQueryKey(slug) });
    },
    onError: (_cause, elementId) => setState(elementId, "failed"),
  });

  if (library.isPending) {
    return (
      <p className="pn-add-line" role="status">
        <Icon name="pin" size={18} />
        <span>{t("en", "add.libraryLoading")}</span>
      </p>
    );
  }
  if (library.isError || !library.data) {
    return (
      <div className="pn-add-lib-state">
        <p className="pn-add-line pn-add-line-error" role="alert">
          <Icon name="info" size={18} />
          <span>{t("en", "add.libraryFailed")}</span>
        </p>
        <Button size="sm" icon="undo" onClick={() => void library.refetch()}>
          {t("en", "add.libraryRetry")}
        </Button>
      </div>
    );
  }
  if (library.data.elements.length === 0) {
    return (
      <p className="pn-add-line" role="status">
        <Icon name="info" size={18} />
        <span>{t("en", "add.libraryEmpty")}</span>
      </p>
    );
  }

  return (
    <ul className="pn-add-lib">
      {library.data.elements.map((card) => {
        const state = states.get(card.elementId) ?? "idle";
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
                {rowButtonLabel(state)}
              </span>
            ) : (
              <Button
                size="sm"
                icon={state === "failed" ? "undo" : "pin"}
                disabled={state === "pinning"}
                aria-label={`${rowButtonLabel(state)}: ${card.label}`}
                onClick={() => pin.mutate(card.elementId)}
              >
                {rowButtonLabel(state)}
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
