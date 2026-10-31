"use client";

import { useEffect, useId, useRef, useState, type ComponentProps } from "react";
import { isAiScene, viewerEscapeTarget } from "../../../domain/scene-viewer";
import { t, tf } from "../../../i18n";
import { useLocale } from "../../../i18n/client";
import { Button, CreditLine, IconButton, Menu, cx } from "../../../ui";
import type { PrintSlot } from "./BoardScenes";
import styles from "./board.module.css";

/** One "More" entry (PIN-143 brings Delete). With none, there is no More button. */
export type ViewerMoreItem = ComponentProps<typeof Menu>["items"][number];

/** The inline delete confirm (PIN-143): it holds the error line, so a failure stays on screen. */
export interface ViewerDeleteConfirm {
  deleting: boolean;
  error: string | null;
  onConfirm: () => void;
  onKeep: () => void;
}

/**
 * Scene viewer (PIN-131): one print full screen. The whole picture
 * (contained, never cropped; pinch-zoom stays the browser's) on the
 * skin's dark ground, then on the paper its idea, every credit, the
 * remix line and Share first. A modal dialog: the board behind it is
 * inert (BoardClient), the page does not scroll, Esc closes and the
 * arrow keys step through the strip's prints. Nothing animates, so
 * reduced motion has nothing to switch off.
 */
export function SceneViewer({
  slot,
  onClose,
  onStep,
  onRemix,
  more = [],
  confirmDelete = null,
}: {
  slot: PrintSlot;
  onClose: () => void;
  /** +1 = the next (older) print in the strip, -1 = the previous one. */
  onStep: (step: 1 | -1) => void;
  onRemix?: () => void;
  more?: ViewerMoreItem[];
  confirmDelete?: ViewerDeleteConfirm | null;
}) {
  const locale = useLocale();
  const titleId = useId();
  const confirmId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLSpanElement>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const confirming = confirmDelete !== null;
  // Latest handlers and state without re-running the open effect (it owns focus and scroll).
  const handlers = useRef({ onClose, onStep, moreOpen, confirmDelete });
  useEffect(() => {
    handlers.current = { onClose, onStep, moreOpen, confirmDelete };
  });
  const focusMore = () => moreRef.current?.querySelector("button")?.focus();
  // Nothing closes the confirm while the delete is in flight: its answer (and error) lands there.
  const keep = () => {
    if (confirmDelete && !confirmDelete.deleting) confirmDelete.onKeep();
  };
  // Back from the confirm (Keep or Esc), focus returns to More.
  const wasConfirming = useRef(false);
  useEffect(() => {
    if (wasConfirming.current && !confirming) focusMore();
    wasConfirming.current = confirming;
  }, [confirming]);
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
    const body = document.body.style;
    const overflow = body.overflow;
    body.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => {
      const { moreOpen: menuOpen, confirmDelete: asked } = handlers.current;
      if (event.key === "Escape") {
        const target = viewerEscapeTarget({ menuOpen, confirming: asked !== null });
        if (target === "menu") {
          setMoreOpen(false);
          focusMore();
        } else if (target === "confirm") {
          if (!asked?.deleting) asked?.onKeep();
        } else handlers.current.onClose();
      } else if (menuOpen || asked !== null) {
        return; // stepping waits until the menu or confirm is closed
      } else if (event.key === "ArrowRight") handlers.current.onStep(1);
      else if (event.key === "ArrowLeft") handlers.current.onStep(-1);
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      body.overflow = overflow;
    };
  }, []);
  return (
    <div ref={ref} className={styles.viewer} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
      <div className={styles.viewerStage}>
        {/* A fresh <img> per scene: stepping shows the dark ground, never the last print, until it loads. */}
        <img key={slot.id} src={slot.src} alt={slot.alt} draggable={false} />
      </div>
      <section className={cx("pn-sheet", styles.viewerPanel)}>
        <div className="pn-sheet-head">
          <h2 className="pn-print-idea" id={titleId}>
            {slot.idea ? tf(locale, "ui.quoted", { text: slot.idea }) : t(locale, "ui.scene")}
          </h2>
          <IconButton icon="close" label={t(locale, "ui.close")} variant="ghost" onClick={onClose} />
        </div>
        <CreditLine items={slot.credits} remixOf={slot.remixOf} className={styles.viewerCredits} />
        {/* PIN-222: AI scenes only; a collage already says what it is. */}
        {isAiScene(slot.kind) ? <p className={styles.viewerComposed}>{t(locale, "ui.sceneComposedBy")}</p> : null}
        {confirmDelete ? (
          // In the actions row's place, inside the panel's flow: never over the idea and Close.
          <div className={styles.viewerConfirm} role="group" aria-labelledby={confirmId}>
            <p id={confirmId}>{t(locale, "board.sceneDeleteConfirm")}</p>
            <div className="pn-print-actions">
              <Button disabled={confirmDelete.deleting} onClick={confirmDelete.onConfirm}>
                {confirmDelete.deleting ? t(locale, "board.deleting") : t(locale, "board.delete")}
              </Button>
              <Button variant="quiet" disabled={confirmDelete.deleting} autoFocus onClick={keep}>
                {t(locale, "board.deleteKeep")}
              </Button>
            </div>
            {confirmDelete.error ? (
              <p className={styles.error} role="alert">
                {confirmDelete.error}
              </p>
            ) : null}
          </div>
        ) : (
          <div className="pn-print-actions">
            <Button variant="primary" icon="share" onClick={slot.onShare} disabled={slot.sharing}>
              {t(locale, "share.button")}
            </Button>
            {onRemix ? (
              <Button icon="remix" onClick={onRemix}>
                {t(locale, "ui.remix")}
              </Button>
            ) : null}
            <span className="pn-spacer" />
            {more.length > 0 ? (
              <span ref={moreRef} className={styles.viewerMore}>
                <IconButton
                  icon="more"
                  label={t(locale, "ui.more")}
                  variant="ghost"
                  aria-haspopup="menu"
                  aria-expanded={moreOpen}
                  onClick={() => setMoreOpen((open) => !open)}
                />
                {moreOpen ? (
                  <Menu
                    items={more.map((item) => ({
                      ...item,
                      onSelect: () => {
                        setMoreOpen(false);
                        item.onSelect?.();
                      },
                    }))}
                    label={t(locale, "ui.more")}
                    className={styles.viewerMenu}
                  />
                ) : null}
              </span>
            ) : null}
          </div>
        )}
        {slot.footer}
      </section>
    </div>
  );
}
