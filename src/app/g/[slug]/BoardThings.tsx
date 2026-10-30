"use client";

import { useEffect, useRef, useState } from "react";
import { canDeleteCard, type PinCard } from "../../../domain/board-view";
import { t, tf } from "../../../i18n";
import { IconButton, Menu, Pin, SectionHead, cx } from "../../../ui";
import styles from "./board.module.css";

export interface DeleteControls {
  /** Element whose delete is waiting for "Yes, delete". */
  confirmElementId: string | null;
  /** Element whose last delete failed. */
  errorElementId: string | null;
  /** Element being deleted right now. */
  deletingElementId: string | null;
  onAsk: (elementId: string) => void;
  onConfirm: (elementId: string) => void;
  onCancel: () => void;
}

/**
 * Things on the board (PIN-98): the kit's Pin grid, three across,
 * with owner names. Every thing is a pick toggle (tapping one at
 * rest starts picking with it). Pinned things only: the uploader's
 * unpinned candidates live in the leftovers line above the grid
 * (PIN-122), never here. Own things get a More menu whose Delete
 * asks once more (PIN-77 owner-only delete).
 */
export function BoardThings({
  cards,
  count,
  meId,
  picking,
  pickNumbers,
  onTapPin,
  deletion,
  foilPinId = null,
  showHead = true,
}: {
  cards: PinCard[];
  count: number;
  meId: string | null;
  picking: boolean;
  pickNumbers: ReadonlyMap<string, number>;
  onTapPin: (pinId: string) => void;
  deletion: DeleteControls;
  /** Board Plus perk (PIN-111): this pin wears foil. */
  foilPinId?: string | null;
  showHead?: boolean;
}) {
  return (
    <section aria-labelledby="board-things">
      {showHead ? (
        <SectionHead title={t("en", "board.pins")} count={count} id="board-things" />
      ) : (
        <h2 className="pn-sr" id="board-things">
          {t("en", "board.pins")}
        </h2>
      )}
      <ul className={cx("pn-pins", styles.pins)}>
        {cards.filter((card) => card.status === "pinned").map((card) => {
          const owner = { id: card.ownerId, name: card.ownerName ?? t("en", "board.someone") };
          const pickIndex = pickNumbers.get(card.pinId);
          const mine = canDeleteCard(card, meId);
          return (
            <li key={card.pinId} className={styles.pinCell} data-pin-id={card.pinId}>
              <Pin
                src={card.element.imageUrl}
                label={card.element.label}
                owner={owner}
                seed={card.element.id}
                state={picking && pickIndex !== undefined ? "picked" : "rest"}
                pickIndex={pickIndex}
                foil={card.pinId === foilPinId}
                onToggle={() => onTapPin(card.pinId)}
              />
              {mine && !picking ? <PinMore card={card} deletion={deletion} /> : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function PinMore({ card, deletion }: { card: PinCard; deletion: DeleteControls }) {
  const elementId = card.element.id;
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<"menu" | "confirm">("menu");
  // Open the menu toward the middle of the screen so it never runs off an edge.
  const [alignStart, setAlignStart] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLSpanElement>(null);
  const confirming = open && step === "confirm" && deletion.confirmElementId === elementId;
  const deleting = deletion.deletingElementId === elementId;

  function close(returnFocus: boolean) {
    setOpen(false);
    setStep("menu");
    if (returnFocus) moreRef.current?.querySelector("button")?.focus();
  }

  // The confirm went away without "Keep" (deleted, or another
  // thing's delete was asked): this menu is done.
  useEffect(() => {
    if (open && step === "confirm" && deletion.confirmElementId !== elementId) {
      setOpen(false);
      setStep("menu");
    }
  }, [open, step, deletion.confirmElementId, elementId]);

  useEffect(() => {
    if (!open) return;
    boxRef.current?.querySelector<HTMLElement>("button:not([disabled])")?.focus();
  }, [open, step]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (boxRef.current?.contains(target) || moreRef.current?.contains(target))) return;
      if (step === "confirm" && !deleting) deletion.onCancel();
      close(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (step === "confirm" && !deleting) deletion.onCancel();
      close(true);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
    // close/deletion are stable enough per render; re-bind on state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, step, deleting]);

  const thing = card.element.label;
  return (
    <>
      <span ref={moreRef} className={styles.pinMore}>
        <IconButton
          icon="more"
          variant="ghost"
          size={20}
          label={tf("en", "board.thingActions", { thing })}
          aria-expanded={open}
          aria-haspopup="menu"
          onClick={() => {
            if (open) {
              close(false);
              return;
            }
            const rect = moreRef.current?.getBoundingClientRect();
            setAlignStart(rect ? rect.left + rect.width / 2 < window.innerWidth / 2 : false);
            setStep("menu");
            setOpen(true);
          }}
        />
      </span>
      {open ? (
        <div ref={boxRef}>
          {confirming ? (
            <div className={cx("pn-menu", alignStart ? styles.pinMenuStart : styles.pinMenu)} role="group" aria-label={thing}>
              <p className={styles.menuText} role="status">
                {t("en", "board.deleteConfirm")}
              </p>
              <button
                type="button"
                className="pn-menu-item"
                data-danger=""
                disabled={deleting}
                onClick={() => deletion.onConfirm(elementId)}
              >
                {deleting ? t("en", "board.deleting") : t("en", "board.deleteYes")}
              </button>
              <button
                type="button"
                className="pn-menu-item"
                disabled={deleting}
                onClick={() => {
                  deletion.onCancel();
                  close(true);
                }}
              >
                {t("en", "board.deleteKeep")}
              </button>
              {deletion.errorElementId === elementId ? (
                <p className={styles.menuError} role="alert">
                  {t("en", "board.deleteFailed")}
                </p>
              ) : null}
            </div>
          ) : (
            <Menu
              label={tf("en", "board.thingActions", { thing })}
              className={alignStart ? styles.pinMenuStart : styles.pinMenu}
              items={[
                {
                  label: t("en", "board.delete"),
                  danger: true,
                  onSelect: () => {
                    deletion.onAsk(elementId);
                    setStep("confirm");
                  },
                },
              ]}
            />
          )}
        </div>
      ) : null}
    </>
  );
}
