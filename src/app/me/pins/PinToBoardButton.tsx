"use client";

import { useState } from "react";
import { t } from "../../../i18n";

type State = "idle" | "pinning" | "pinned" | "already" | "failed";

/**
 * Pin-to-this-board action (PIN-85): shown on /me/pins when the
 * page was opened with a board context (?board=<slug>). Posts
 * to the board's from-library route; a repeat pin comes back
 * as the friendly already-pinned state, never an error.
 */
export function PinToBoardButton({
  slug,
  elementId,
}: {
  slug: string;
  elementId: string;
}) {
  const [state, setState] = useState<State>("idle");
  const pinned = state === "pinned" || state === "already";
  return (
    <button
      type="button"
      className="btn btn-small"
      disabled={state === "pinning" || pinned}
      onClick={() => {
        setState("pinning");
        void (async () => {
          try {
            const response = await fetch(
              `/api/boards/${encodeURIComponent(slug)}/pins/from-library`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ elementId }),
              },
            );
            const data = (await response.json()) as { alreadyPinned?: boolean };
            if (!response.ok) throw new Error("pin failed");
            setState(data.alreadyPinned ? "already" : "pinned");
          } catch {
            setState("failed");
          }
        })();
      }}
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
  );
}
