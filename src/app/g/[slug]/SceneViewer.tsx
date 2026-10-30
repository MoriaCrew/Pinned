"use client";

import { useEffect, useId, useRef, useState, type ComponentProps } from "react";
import { t } from "../../../i18n";
import { Button, CreditLine, IconButton, Menu, cx } from "../../../ui";
import type { PrintSlot } from "./BoardScenes";
import styles from "./board.module.css";

/** One "More" entry (PIN-132 brings Delete). With none, there is no More button. */
export type ViewerMoreItem = ComponentProps<typeof Menu>["items"][number];

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
}: {
  slot: PrintSlot;
  onClose: () => void;
  /** +1 = the next (older) print in the strip, -1 = the previous one. */
  onStep: (step: 1 | -1) => void;
  onRemix?: () => void;
  more?: ViewerMoreItem[];
}) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  // Latest handlers without re-running the open effect (it owns focus and scroll).
  const handlers = useRef({ onClose, onStep });
  useEffect(() => {
    handlers.current = { onClose, onStep };
  });
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
    const body = document.body.style;
    const overflow = body.overflow;
    body.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") handlers.current.onClose();
      else if (event.key === "ArrowRight") handlers.current.onStep(1);
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
        {/* eslint-disable-next-line @next/next/no-img-element -- board-link-checked scene image, full size */}
        <img src={slot.src} alt={slot.alt} draggable={false} />
      </div>
      <section className={cx("pn-sheet", styles.viewerPanel)}>
        <div className="pn-sheet-head">
          <h2 className="pn-print-idea" id={titleId}>
            {slot.idea ? `“${slot.idea}”` : t("en", "ui.scene")}
          </h2>
          <IconButton icon="close" label={t("en", "ui.close")} variant="ghost" onClick={onClose} />
        </div>
        <CreditLine items={slot.credits} remixOf={slot.remixOf} />
        <div className="pn-print-actions">
          <Button variant="primary" icon="share" onClick={slot.onShare} disabled={slot.sharing}>
            {t("en", "share.button")}
          </Button>
          {onRemix ? (
            <Button icon="remix" onClick={onRemix}>
              {t("en", "ui.remix")}
            </Button>
          ) : null}
          <span className="pn-spacer" />
          {more.length > 0 ? (
            <span className={styles.viewerMore}>
              <IconButton
                icon="more"
                label={t("en", "ui.more")}
                variant="ghost"
                aria-haspopup="menu"
                aria-expanded={moreOpen}
                onClick={() => setMoreOpen((open) => !open)}
              />
              {moreOpen ? <Menu items={more} label={t("en", "ui.more")} className={styles.viewerMenu} /> : null}
            </span>
          ) : null}
        </div>
        {slot.footer}
      </section>
    </div>
  );
}
