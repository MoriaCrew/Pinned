"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { afterBoardDeleteHref, runBoardDelete, type BoardDeletePhase } from "../../../domain/board-delete-ui";
import { t, tf } from "../../../i18n";
import { useLocale } from "../../../i18n/client";
import { Button, Sheet } from "../../../ui";
import { boardQueryKey } from "./board-query";
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
  const locale = useLocale();
  const keepId = useId();
  const keep = () => {
    if (!busy) onKeep();
  };
  return (
    <Sheet
      title={t(locale, "board.deleteBoardTitle")}
      onClose={keep}
      initialFocusId={keepId}
      footer={
        <>
          <Button size="lg" block className={styles.deleteYes} disabled={busy} onClick={onDelete}>
            {busy ? t(locale, "board.deleting") : t(locale, "board.deleteBoardYes")}
          </Button>
          <Button id={keepId} size="lg" block disabled={busy} onClick={keep}>
            {t(locale, "board.deleteBoardKeep")}
          </Button>
        </>
      }
    >
      <div className={styles.deleteText}>
        <p className={styles.deleteName}>{tf(locale, "board.deleteBoardName", { board: title })}</p>
        <p className={styles.deleteBody}>{t(locale, "board.deleteBoardBody")}</p>
        <p className={styles.deleteError} role="alert">
          {error === "failed"
            ? t(locale, "board.deleteBoardFailed")
            : error === "gone"
              ? t(locale, "board.deleteBoardGone")
              : ""}
        </p>
      </div>
    </Sheet>
  );
}

/**
 * Runs the delete: `DELETE /api/boards/{slug}` (the host cookie rides
 * along, PIN-167). The board page pauses its poll while the request
 * runs (`onPhase`). On 204 it gives way to the landing with the "Board
 * deleted" notice, which replaces this history entry so Back never
 * returns to a dead board. On a 404 or any failure the board stays,
 * the poll resumes and the sheet says why.
 */
export function DeleteBoardSheet({
  slug,
  title,
  signedIn,
  onPhase,
  onClose,
}: {
  slug: string;
  title: string;
  /** My boards is the landing for a signed-in host, the home page otherwise. */
  signedIn: boolean;
  /** Where our own delete is: the page polls only while "idle" and drops the board's data on "left". */
  onPhase: (phase: BoardDeletePhase) => void;
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
    const outcome = await runBoardDelete(slug, (url, init) => fetch(url, init), onPhase);
    if (outcome === "deleted") {
      // Stays "Deleting…" until the landing page replaces this one.
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
