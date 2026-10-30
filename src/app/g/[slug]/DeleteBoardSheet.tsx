"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { afterBoardDeleteHref, boardDeleteOutcome } from "../../../domain/board-delete-ui";
import { t, tf } from "../../../i18n";
import { Button, Sheet } from "../../../ui";
import { boardQueryKey } from "./AddSheet";
import styles from "./board.module.css";

/** What the sheet says when a delete did not happen: "" (nothing), a retryable failure, or "already gone / not the host". */
type DeleteBoardError = "" | "failed" | "gone";

/**
 * The host's Delete board confirm (PIN-168): a sheet that names the
 * board and says it is gone for everyone, pictures included, and can't
 * be undone. Focus starts on Keep board (the safe answer, a plain
 * secondary button so no skin's accent colour makes it look like the
 * danger), Delete board takes the destructive outline, Escape and the
 * scrim keep the board, and nothing closes it while the delete is in
 * flight. The error line is always mounted so a screen reader hears
 * it arrive; the sheet grows upward around it, never under the thumb.
 */
export function DeleteBoardSheetView({
  title,
  busy = false,
  error = "",
  onDelete,
  onKeep,
}: {
  title: string;
  busy?: boolean;
  error?: DeleteBoardError;
  onDelete: () => void;
  onKeep: () => void;
}) {
  const keepId = useId();
  const keep = () => {
    if (!busy) onKeep();
  };
  return (
    <Sheet
      title={t("en", "board.deleteBoardTitle")}
      onClose={keep}
      initialFocusId={keepId}
      footer={
        <>
          <Button size="lg" block className={styles.deleteYes} disabled={busy} onClick={onDelete}>
            {busy ? t("en", "board.deleting") : t("en", "board.deleteBoardYes")}
          </Button>
          <Button id={keepId} size="lg" block disabled={busy} onClick={keep}>
            {t("en", "board.deleteBoardKeep")}
          </Button>
        </>
      }
    >
      <div className={styles.deleteText}>
        <p className={styles.deleteName}>{tf("en", "board.deleteBoardName", { board: title })}</p>
        <p className={styles.deleteBody}>{t("en", "board.deleteBoardBody")}</p>
        <p className={styles.deleteError} role="alert">
          {error === "failed"
            ? t("en", "board.deleteBoardFailed")
            : error === "gone"
              ? t("en", "board.deleteBoardGone")
              : ""}
        </p>
      </div>
    </Sheet>
  );
}

/**
 * Runs the delete: `DELETE /api/boards/{slug}` (the host cookie rides
 * along, PIN-167). On 204 the board page stops polling (`onDeleted`)
 * and gives way to the landing with the "Board deleted" notice, which
 * replaces this history entry so Back never returns to a dead board.
 * On a 404 or any failure the board stays and the sheet says why.
 */
export function DeleteBoardSheet({
  slug,
  title,
  signedIn,
  onDeleted,
  onClose,
}: {
  slug: string;
  title: string;
  /** My boards is the landing for a signed-in host, the home page otherwise. */
  signedIn: boolean;
  /** The board is gone: stop polling and drop its cached data. */
  onDeleted: () => void;
  onClose: () => void;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<DeleteBoardError>("");

  async function remove() {
    if (busy) return;
    setBusy(true);
    setError("");
    let response: Response | null = null;
    try {
      response = await fetch(`/api/boards/${encodeURIComponent(slug)}`, {
        method: "DELETE",
        credentials: "same-origin",
      });
    } catch {
      // Offline or dropped: the same retryable failure as a 500.
    }
    const outcome = boardDeleteOutcome(response);
    if (outcome === "deleted") {
      // Stays "Deleting…" until the landing page replaces this one.
      onDeleted();
      router.replace(afterBoardDeleteHref(signedIn));
      return;
    }
    setBusy(false);
    setError(outcome);
    // A 404: look at the board now instead of at the next poll (the page swaps to not-found if it is gone).
    if (outcome === "gone") void queryClient.invalidateQueries({ queryKey: boardQueryKey(slug) });
  }

  return <DeleteBoardSheetView title={title} busy={busy} error={error} onDelete={() => void remove()} onKeep={onClose} />;
}
