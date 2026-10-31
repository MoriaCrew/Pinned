"use client";

import { useEffect, useRef, useState } from "react";
import { canDeleteCard, type PinCard } from "../../../domain/board-view";
import { t, tf, type Locale } from "../../../i18n";
import { useLocale } from "../../../i18n/client";
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
 * asks once more (PIN-77 owner-only delete) and whose Rename opens
 * the board's rename sheet (PIN-157).
 */
export function BoardThings({
  cards,
  count,
  meId,
  picking,
  pickNumbers,
  onTapPin,
  deletion,
  onRename,
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
  /** Rename in a thing's More menu: the board opens the rename sheet (PIN-157). */
  onRename?: (elementId: string) => void;
  /** Board Plus perk (PIN-111): this pin wears foil. */
  foilPinId?: string | null;
  showHead?: boolean;
}) {
  const locale = useLocale();
  return (
    <section aria-labelledby="board-things">
      {showHead ? (
        <SectionHead title={t(locale, "board.pins")} count={count} id="board-things" />
      ) : (
        <h2 className="pn-sr" id="board-things">
          {t(locale, "board.pins")}
        </h2>
      )}
      <ul className={cx("pn-pins", styles.pins)}>
        {cards.filter((card) => card.status === "pinned").map((card) => {
          const owner = { id: card.ownerId, name: card.ownerName ?? t(locale, "board.someone") };
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
              {mine && !picking ? <PinMore card={card} deletion={deletion} onRename={onRename} /> : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** The More menu's items, in order: Rename (when the board can rename), then Delete. */
export function pinMenuItems(locale: Locale, actions: { onRename?: () => void; onDelete: () => void }) {
  return [
    ...(actions.onRename ? [{ label: t(locale, "board.rename"), onSelect: actions.onRename }] : []),
    { label: t(locale, "board.delete"), danger: true, onSelect: actions.onDelete },
  ];
}

function PinMore({
  card,
  deletion,
  onRename,
}: {
  card: PinCard;
  deletion: DeleteControls;
  onRename?: (elementId: string) => void;
}) {
  const locale = useLocale();
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
  }, [open, step, deleting]);

  const thing = card.element.label;
  return (
    <>
      <span ref={moreRef} className={styles.pinMore}>
        <IconButton
          icon="more"
          variant="ghost"
          size={20}
          label={tf(locale, "board.thingActions", { thing })}
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
                {t(locale, "board.deleteConfirm")}
              </p>
              <button
                type="button"
                className="pn-menu-item"
                data-danger=""
                disabled={deleting}
                onClick={() => deletion.onConfirm(elementId)}
              >
                {deleting ? t(locale, "board.deleting") : t(locale, "board.deleteYes")}
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
                {t(locale, "board.deleteKeep")}
              </button>
              {deletion.errorElementId === elementId ? (
                <p className={styles.menuError} role="alert">
                  {t(locale, "board.deleteFailed")}
                </p>
              ) : null}
            </div>
          ) : (
            <Menu
              label={tf(locale, "board.thingActions", { thing })}
              className={alignStart ? styles.pinMenuStart : styles.pinMenu}
              items={pinMenuItems(locale, {
                onRename: onRename
                  ? () => {
                      // Focus goes back to More first: the sheet hands it back there when it closes.
                      close(true);
                      onRename(elementId);
                    }
                  : undefined,
                onDelete: () => {
                  deletion.onAsk(elementId);
                  setStep("confirm");
                },
              })}
            />
          )}
        </div>
      ) : null}
    </>
  );
}
