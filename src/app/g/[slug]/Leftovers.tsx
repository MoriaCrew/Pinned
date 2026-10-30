"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { withoutLeftovers, type LeftoverGroup, type Leftovers } from "../../../domain/leftovers";
import { t, tCount, tf } from "../../../i18n";
import { Button, Icon, Sticker } from "../../../ui";
import { boardQueryKey } from "./AddSheet";
import type { BoardClientView } from "./BoardClient";

/** "{n} things from your last photo aren't pinned"; "photos" when there are several. */
export function leftoversLine(leftovers: Leftovers): string {
  return leftovers.groups.length > 1
    ? tf("en", "leftovers.linePhotos", { n: leftovers.count })
    : tCount("en", "leftovers.line", leftovers.count);
}

/**
 * The leftovers line (PIN-122), shown above the Things grid instead
 * of "Not pinned yet" stickers in it: the newest photo's stickers,
 * one sentence, Pin them (reopens that photo's review) and Clear,
 * which asks once and then drops them through the confirm route
 * with none kept (one call per photo; it also deletes each photo's
 * working copy, like Pin N does).
 */
export function LeftoversLine({
  leftovers,
  stickers,
  confirming,
  clearing,
  error,
  focusClear = false,
  onPin,
  onAskClear,
  onClear,
  onKeep,
}: {
  leftovers: Leftovers;
  /** The newest photo's cut-outs (at most Policy.elementsPerPhoto.max). */
  stickers: { src: string; seed: string }[];
  confirming: boolean;
  clearing: boolean;
  /** The Clear error line (still cutting, or a failed call); null when fine. */
  error: string | null;
  /** Back from the confirm step: focus returns to Clear. */
  focusClear?: boolean;
  onPin: () => void;
  onAskClear: () => void;
  onClear: () => void;
  onKeep: () => void;
}) {
  const n = leftovers.count;
  return (
    <div className="pn-leftovers" data-confirming={confirming ? "" : undefined}>
      {stickers.length > 0 ? (
        <span className="pn-leftovers-stack" aria-hidden="true">
          {stickers.map((sticker) => (
            <Sticker key={sticker.seed} src={sticker.src} seed={sticker.seed} size={36} />
          ))}
        </span>
      ) : null}
      <p className="pn-leftovers-text" role="status">
        {confirming ? tCount("en", "leftovers.clearConfirm", n) : leftoversLine(leftovers)}
      </p>
      <div className="pn-leftovers-actions">
        {confirming ? (
          <>
            <Button size="sm" variant="secondary" disabled={clearing} onClick={onClear}>
              {clearing ? t("en", "leftovers.clearing") : t("en", "leftovers.clearYes")}
            </Button>
            <Button size="sm" variant="quiet" disabled={clearing} autoFocus onClick={onKeep}>
              {t("en", "leftovers.keep")}
            </Button>
          </>
        ) : (
          <>
            <Button size="sm" variant="secondary" icon="pin" onClick={onPin}>
              {tCount("en", "leftovers.pin", n)}
            </Button>
            <Button size="sm" variant="quiet" autoFocus={focusClear} onClick={onAskClear}>
              {t("en", "leftovers.clear")}
            </Button>
          </>
        )}
      </div>
      {error ? (
        <p className="pn-leftovers-error" role="alert">
          <Icon name="info" size={16} />
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Stateful wrapper: the Clear confirm step and the confirm-route calls. */
export function BoardLeftovers({
  slug,
  leftovers,
  elements,
  onPin,
}: {
  slug: string;
  leftovers: Leftovers;
  elements: readonly { id: string; imageUrl: string }[];
  onPin: (group: LeftoverGroup) => void;
}) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [keptOnce, setKeptOnce] = useState(false);

  const clear = useMutation({
    mutationFn: async (groups: LeftoverGroup[]) => {
      await Promise.all(
        groups.map(async (group) => {
          const response = await fetch(`/api/boards/${encodeURIComponent(slug)}/pins/confirm`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jobId: group.jobId, pinIds: [] }),
          });
          // 409: that photo is still being cut, so it cannot be cleared yet.
          if (response.status === 409) throw new Error(t("en", "leftovers.clearBusy"));
          if (!response.ok) throw new Error(t("en", "leftovers.clearFailed"));
        }),
      );
    },
    // Not optimistic (PIN-122 Bugbot): taking the leftovers out of the
    // board before the server answers would unmount this line, and
    // with it "Clearing…" and any error. They leave once it succeeds.
    onSuccess: async (_data, groups) => {
      await queryClient.cancelQueries({ queryKey: boardQueryKey(slug) });
      const current = queryClient.getQueryData<BoardClientView>(boardQueryKey(slug));
      if (current) queryClient.setQueryData(boardQueryKey(slug), withoutLeftovers(current, groups));
      setConfirming(false);
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: boardQueryKey(slug) }),
  });

  const newest = leftovers.groups[0];
  if (!newest) return null;
  const imageById = new Map(elements.map((element) => [element.id, element.imageUrl]));
  const stickers = newest.elementIds.flatMap((id) => {
    const src = imageById.get(id);
    return src ? [{ src, seed: id }] : [];
  });

  return (
    <LeftoversLine
      leftovers={leftovers}
      stickers={stickers}
      confirming={confirming}
      clearing={clear.isPending}
      error={clear.isError ? clear.error.message || t("en", "leftovers.clearFailed") : null}
      focusClear={keptOnce}
      onPin={() => onPin(newest)}
      onAskClear={() => {
        clear.reset();
        setConfirming(true);
      }}
      onClear={() => clear.mutate(leftovers.groups)}
      onKeep={() => {
        clear.reset();
        setConfirming(false);
        setKeptOnce(true);
      }}
    />
  );
}
