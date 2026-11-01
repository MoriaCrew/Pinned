"use client";

import { useState } from "react";
import { useLocale } from "../../../i18n/client";
import { Button } from "../../../ui";
import { pinButtonView, type PinButtonState } from "../library-format";

/**
 * Pin-here action (PIN-85, restyled in PIN-104): shown on /me/pins
 * when the page was opened with a board context (?board=<slug>).
 * Posts to the board's from-library route; a repeat pin comes back
 * as the friendly already-pinned state, never an error. In flight
 * and settled states stay on the same button (so keyboard focus
 * stays put) and are announced politely.
 */
export function PinToBoardButton({
  slug,
  elementId,
  label,
}: {
  slug: string;
  elementId: string;
  /** The thing's name, so each button is spoken as "Pin here: Teal mug". */
  label: string;
}) {
  const locale = useLocale();
  const [state, setState] = useState<PinButtonState>("idle");
  const view = pinButtonView(locale, state);
  const spoken = `${view.label}: ${label}`;
  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        block
        icon={view.icon}
        className="pn-lib-pin-btn"
        data-state={state}
        aria-label={spoken}
        aria-disabled={view.inert || undefined}
        onClick={() => {
          if (view.inert) return;
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
        {view.label}
      </Button>
      <span className="pn-sr" role="status">
        {state === "idle" ? "" : spoken}
      </span>
    </>
  );
}
