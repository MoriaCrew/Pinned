"use client";

import { useEffect } from "react";
import { urlWithoutBoardDeletedFlag } from "../../domain/board-delete-ui";
import { t } from "../../i18n";
import { Icon } from "../../ui";

/**
 * The one-line "Board deleted" notice (PIN-168) where the host lands
 * after deleting a board: the page renders it from `?deleted=1`, and
 * the flag leaves the address bar at once, so a reload or a shared
 * link shows the page as it is. It carries no slug.
 */
export function BoardDeletedNotice({ show }: { show: boolean }) {
  useEffect(() => {
    if (!show) return;
    const next = urlWithoutBoardDeletedFlag(window.location.href);
    if (next !== null) window.history.replaceState(window.history.state, "", next);
  }, [show]);
  if (!show) return null;
  return (
    <p className="pn-lib-notice" role="status">
      <Icon name="check" size={20} />
      {t("en", "board.deletedNotice")}
    </p>
  );
}
