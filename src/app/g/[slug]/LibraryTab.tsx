"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { MyPinCard } from "../../../domain/my-pins";
import { t } from "../../../i18n";
import { boardQueryKey } from "./AddSheet";

interface MyPinsResponse {
  elements: MyPinCard[];
  total: number;
  limit: number;
}

/**
 * "From my pins" Add-sheet tab (PIN-85): the signed-in user's
 * library (GET /api/me/elements) with a Pin button per element.
 * Pinning posts to this board's from-library route and then
 * invalidates the board query, so the new pin pops into the
 * grid behind the sheet; a repeat pin reads back as the
 * friendly already-pinned state. Rendered only for signed-in
 * users — the parent sheet hides the tab otherwise, so the
 * link-only Add flow is untouched.
 */
export function LibraryTab({ slug }: { slug: string }) {
  const queryClient = useQueryClient();
  const [states, setStates] = useState<ReadonlyMap<string, string>>(new Map());

  const library = useQuery({
    queryKey: ["my-pins"],
    queryFn: async (): Promise<MyPinsResponse> => {
      const response = await fetch("/api/me/elements", { cache: "no-store" });
      const data = (await response.json()) as MyPinsResponse & { error?: string };
      if (!response.ok) throw new Error(data.error || t("en", "myPins.failed"));
      return data;
    },
  });

  const setState = (elementId: string, value: string) =>
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
      if (!response.ok) throw new Error(data.error || t("en", "myPins.failed"));
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
      <p className="hint" role="status">
        {t("en", "myPins.loading")}
      </p>
    );
  }
  if (library.isError || !library.data) {
    return (
      <p className="error" role="alert">
        {t("en", "myPins.failed")}
      </p>
    );
  }
  if (library.data.elements.length === 0) {
    return <p className="hint" role="status">{t("en", "myPins.empty")}</p>;
  }

  return (
    <ul className="pins-grid">
      {library.data.elements.map((card) => {
        const state = states.get(card.elementId) ?? "idle";
        const done = state === "pinned" || state === "already";
        return (
          <li key={card.elementId} className="pin-card">
            {/* eslint-disable-next-line @next/next/no-img-element -- owner-checked API image */}
            <img src={card.imageUrl} alt={card.label} loading="lazy" />
            <span className="pin-label">{card.label}</span>
            <span className="my-pin-source">
              {t("en", "myPins.fromBoard")} {card.sourceBoardTitle}
            </span>
            <button
              type="button"
              className="btn btn-small"
              disabled={state === "pinning" || done}
              onClick={() => pin.mutate(card.elementId)}
            >
              {state === "pinning"
                ? t("en", "myPins.pinning")
                : state === "pinned"
                  ? t("en", "myPins.pinned")
                  : state === "already"
                    ? t("en", "myPins.alreadyPinned")
                    : state === "failed"
                      ? t("en", "myPins.failed")
                      : t("en", "myPins.pinToBoard")}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
