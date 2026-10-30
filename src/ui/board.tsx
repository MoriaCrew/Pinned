"use client";

import { useEffect, useId, useRef, type CSSProperties, type ReactNode } from "react";
import { t, tCount } from "../i18n";
import { AvatarStack, Button, IconButton, Wordmark, cx, pickedCountLabel, type Person } from "./primitives";

export interface BoardCounts {
  people?: number;
  things?: number;
  scenes?: number;
}

/** "6 people · 14 things · 6 scenes" (only the counts given). */
export function boardMetaLine(counts: BoardCounts): string {
  const parts: string[] = [];
  if (counts.people !== undefined) parts.push(tCount("en", "meta.people", counts.people));
  if (counts.things !== undefined) parts.push(tCount("en", "meta.things", counts.things));
  if (counts.scenes !== undefined) parts.push(tCount("en", "meta.scenes", counts.scenes));
  return parts.join(" · ");
}

/** Top of a board: wordmark, who's here, share, the name in the skin's display face, counts. */
export function BoardHeader({
  title,
  people,
  counts,
  onShare,
  shareLabel = t("en", "ui.shareBoard"),
  homeHref,
  actions,
  className,
}: {
  title: string;
  people?: Person[];
  counts?: BoardCounts;
  onShare?: () => void;
  shareLabel?: string;
  homeHref?: string;
  /** Extra header controls (e.g. the board's More menu). */
  actions?: ReactNode;
  className?: string;
}) {
  const meta = counts ? boardMetaLine(counts) : "";
  return (
    <header className={cx("pn-head", className)}>
      <div className="pn-head-row">
        <Wordmark size={22} href={homeHref} />
        <div className="pn-head-right">
          {people && people.length > 0 ? <AvatarStack people={people} max={3} /> : null}
          {onShare ? <IconButton icon="share" label={shareLabel} onClick={onShare} /> : null}
          {actions}
        </div>
      </div>
      <h1 className="pn-board-title">{title}</h1>
      {meta ? <p className="pn-board-meta">{meta}</p> : null}
    </header>
  );
}

/** Section head on the board ("Scenes", "Things") with an optional mono count. */
export function SectionHead({ title, count, id }: { title: string; count?: number; id?: string }) {
  return (
    <div className="pn-section-head">
      <h2 className="pn-section-title" id={id}>
        {title}
      </h2>
      {count !== undefined ? <span className="pn-board-meta">{count}</span> : null}
    </div>
  );
}

/**
 * The two board actions in the thumb zone; while picking it turns
 * into the tray (slots = Policy pinsPerScene.max).
 */
export function Dock(
  props:
    | {
        mode?: "idle";
        onAdd?: () => void;
        onMake?: () => void;
        addLabel?: string;
        makeLabel?: string;
        makeDisabled?: boolean;
        fixed?: boolean;
        className?: string;
      }
    | {
        mode: "picking";
        picked: { src: string; label?: string }[];
        max: number;
        onCancel?: () => void;
        onNext?: () => void;
        nextLabel?: string;
        nextDisabled?: boolean;
        cancelLabel?: string;
        fixed?: boolean;
        className?: string;
      },
) {
  const cls = cx("pn-dock", props.fixed && "pn-dock-fixed", props.className);
  if (props.mode === "picking") {
    const slots = Array.from({ length: props.max }, (_, i) => props.picked[i] ?? null);
    return (
      <nav className={cls} aria-label={t("en", "ui.pickedThings")}>
        <IconButton icon="close" label={props.cancelLabel ?? t("en", "ui.stopPicking")} variant="ghost" onClick={props.onCancel} />
        <ol className="pn-tray" aria-label={t("en", "ui.pickedThings")}>
          {slots.map((slot, i) => (
            <li key={i} className={cx("pn-tray-slot", slot && "is-filled")}>
              {slot ? (
                // eslint-disable-next-line @next/next/no-img-element -- board-link-checked cut-out
                <img src={slot.src} alt={slot.label ?? ""} />
              ) : null}
            </li>
          ))}
        </ol>
        <span className="pn-sr" aria-live="polite">
          {pickedCountLabel(props.picked.length, props.max)}
        </span>
        <Button
          variant="primary"
          size="lg"
          iconEnd="arrow"
          disabled={props.nextDisabled ?? props.picked.length === 0}
          onClick={props.onNext}
          style={{ flex: "0 0 auto" }}
        >
          {props.nextLabel ?? t("en", "ui.next")}
        </Button>
      </nav>
    );
  }
  return (
    <nav className={cls} aria-label={t("en", "ui.boardActions")}>
      <Button variant="primary" size="lg" icon="camera" onClick={props.onAdd}>
        {props.addLabel ?? t("en", "ui.addPhoto")}
      </Button>
      <Button variant="secondary" size="lg" icon="scene" onClick={props.onMake} disabled={props.makeDisabled}>
        {props.makeLabel ?? t("en", "ui.makeScene")}
      </Button>
    </nav>
  );
}

/**
 * Bottom sheet for every flow (add a photo, make a scene, pick a
 * look, join). With `layer` it renders the scrim, closes on Escape
 * and on a scrim tap, and moves focus into the sheet.
 */
export function Sheet({
  title,
  onClose,
  closeLabel = t("en", "ui.close"),
  footer,
  layer = "fixed",
  children,
  className,
  labelledBy,
}: {
  title: ReactNode;
  onClose?: () => void;
  closeLabel?: string;
  footer?: ReactNode;
  /** "fixed" for the app, "absolute" inside a preview frame, "none" to place it yourself. */
  layer?: "fixed" | "absolute" | "none";
  children?: ReactNode;
  className?: string;
  labelledBy?: string;
}) {
  const autoId = useId();
  const titleId = labelledBy ?? `${autoId}-title`;
  const ref = useRef<HTMLElement>(null);
  // Latest onClose without re-running the focus effect: callers pass
  // inline handlers, and re-running would yank focus out of fields.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });
  const modal = layer === "fixed";
  useEffect(() => {
    // Only a live, fixed sheet is a modal: it takes focus once when it
    // opens, closes on Escape and hands focus back when it goes away.
    if (!modal) return;
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current?.();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus?.({ preventScroll: true });
    };
  }, [modal]);
  const sheet = (
    <section
      ref={ref}
      tabIndex={-1}
      className={cx("pn-sheet", className)}
      role="dialog"
      aria-modal={modal ? true : undefined}
      aria-labelledby={titleId}
    >
      <span className="pn-sheet-grab" aria-hidden="true" />
      <div className="pn-sheet-head">
        <h2 className="pn-sheet-title" id={titleId}>
          {title}
        </h2>
        {onClose ? <IconButton icon="close" label={closeLabel} variant="ghost" onClick={onClose} /> : null}
      </div>
      <div className="pn-sheet-body">{children}</div>
      {footer ? <div className="pn-sheet-foot">{footer}</div> : null}
    </section>
  );
  if (layer === "none") return sheet;
  return (
    <div className="pn-sheet-layer" style={{ position: layer, inset: 0, zIndex: 40, display: "flex", alignItems: "flex-end" }}>
      <div className="pn-scrim" onClick={onClose} aria-hidden="true" />
      {sheet}
    </div>
  );
}

/** A brand-new board: ghost outlines, one line, the two first actions. */
export function EmptyState({
  title = t("en", "ui.emptyTitle"),
  body = t("en", "ui.emptyBody"),
  actionLabel = t("en", "ui.emptyAction"),
  shareLabel = t("en", "ui.emptyShare"),
  onAction,
  onShare,
  className,
}: {
  title?: string;
  body?: string;
  actionLabel?: string;
  shareLabel?: string;
  onAction?: () => void;
  onShare?: () => void;
  className?: string;
}) {
  return (
    <section className={cx("pn-empty", className)}>
      <div className="pn-empty-ghosts" aria-hidden="true">
        <span className="pn-ghost" style={{ "--t": -0.8 } as CSSProperties} />
        <span className="pn-ghost pn-ghost-tall" style={{ "--t": 0.6 } as CSSProperties} />
        <span className="pn-ghost pn-ghost-wide" style={{ "--t": -0.3 } as CSSProperties} />
      </div>
      <h2 className="pn-section-title">{title}</h2>
      <p className="pn-empty-body">{body}</p>
      <div className="pn-empty-actions">
        {onAction ? (
          <Button variant="primary" size="lg" icon="camera" onClick={onAction}>
            {actionLabel}
          </Button>
        ) : null}
        {onShare ? (
          <Button variant="secondary" size="lg" icon="share" onClick={onShare}>
            {shareLabel}
          </Button>
        ) : null}
      </div>
    </section>
  );
}

/** A small popover menu (e.g. a pin's or a scene's More). The caller positions and opens it. */
export function Menu({
  items,
  label,
  className,
  style,
}: {
  items: { label: string; onSelect: () => void; danger?: boolean; disabled?: boolean }[];
  label: string;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div className={cx("pn-menu", className)} role="menu" aria-label={label} style={style}>
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          className="pn-menu-item"
          data-danger={item.danger ? "" : undefined}
          disabled={item.disabled}
          onClick={item.onSelect}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
