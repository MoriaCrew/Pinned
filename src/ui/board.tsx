"use client";

import Link from "next/link";
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

/**
 * Top of a board: wordmark, share and the viewer's own "you" button
 * (PIN-120), the name in the skin's display face, then who's here as
 * a small stack at the start of the counts line.
 */
export function BoardHeader({
  title,
  people,
  peopleLabel,
  counts,
  onShare,
  shareLabel = t("en", "ui.shareBoard"),
  homeHref,
  you,
  className,
}: {
  title: string;
  /** Who's here (on a live board: everyone but the viewer, who has `you`). */
  people?: Person[];
  /** Spoken name of the people stack (default: the count and every name). */
  peopleLabel?: string;
  counts?: BoardCounts;
  onShare?: () => void;
  shareLabel?: string;
  homeHref?: string;
  /** The viewer's own button, last in the top row. */
  you?: ReactNode;
  className?: string;
}) {
  const meta = counts ? boardMetaLine(counts) : "";
  const stack = people && people.length > 0 ? <AvatarStack people={people} max={3} size="sm" label={peopleLabel} /> : null;
  return (
    <header className={cx("pn-head", className)}>
      <div className="pn-head-row">
        <Wordmark size={22} href={homeHref} />
        <div className="pn-head-right">
          {onShare ? <IconButton icon="share" label={shareLabel} onClick={onShare} /> : null}
          {you}
        </div>
      </div>
      <h1 className="pn-board-title">{title}</h1>
      {meta || stack ? (
        <p className="pn-board-meta pn-head-meta">
          {stack}
          {meta ? <span>{meta}</span> : null}
        </p>
      ) : null}
    </header>
  );
}

/** Section head on the board ("Scenes", "Things") with an optional mono count. */
/** `focusable`: the heading can take focus from script (tabIndex -1), e.g. after its last item goes. */
export function SectionHead({ title, count, id, focusable }: { title: string; count?: number; id?: string; focusable?: boolean }) {
  return (
    <div className="pn-section-head">
      <h2 className="pn-section-title" id={id} tabIndex={focusable ? -1 : undefined}>
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
  initialFocusId,
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
  /** Id of the field to put the caret in when the sheet opens (else the sheet itself). */
  initialFocusId?: string;
}) {
  const autoId = useId();
  const titleId = labelledBy ?? `${autoId}-title`;
  const ref = useRef<HTMLElement>(null);
  // Latest onClose without re-running the focus effect: callers pass
  // inline handlers, and re-running would yank focus out of fields.
  const onCloseRef = useRef(onClose);
  const initialFocusRef = useRef(initialFocusId);
  useEffect(() => {
    onCloseRef.current = onClose;
    initialFocusRef.current = initialFocusId;
  });
  const modal = layer === "fixed";
  useEffect(() => {
    // Only a live, fixed sheet is a modal: it takes focus once when it
    // opens, closes on Escape and hands focus back when it goes away.
    if (!modal) return;
    const previous = document.activeElement as HTMLElement | null;
    // The sheet owns the opening focus so `previous` is always the
    // control that opened it, never a field inside the sheet.
    const field = initialFocusRef.current ? document.getElementById(initialFocusRef.current) : null;
    (field ?? ref.current)?.focus({ preventScroll: true });
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
  note,
  className,
  style,
}: {
  /**
   * An item with `href` is a real link (client-side navigation); onSelect still runs on click.
   * `detail` is a quiet second line under the label (e.g. "3 creations left"), read with it.
   */
  items: {
    label: string;
    detail?: string;
    onSelect?: () => void;
    href?: string;
    danger?: boolean;
    disabled?: boolean;
  }[];
  label: string;
  /**
   * A quiet line above the items (e.g. "You're Sam here"). Shown, not
   * spoken: say the same thing in `label` so screen readers hear it.
   */
  note?: string;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div className={cx("pn-menu", className)} role="menu" aria-label={label} style={style}>
      {note ? (
        <p className="pn-menu-note" aria-hidden="true">
          {note}
        </p>
      ) : null}
      {items.map((item) => {
        const text = (
          <>
            {item.label}
            {item.detail ? <span className="pn-menu-detail">{item.detail}</span> : null}
          </>
        );
        return item.href && !item.disabled ? (
          <Link
            key={item.label}
            href={item.href}
            role="menuitem"
            className="pn-menu-item"
            data-danger={item.danger ? "" : undefined}
            data-detail={item.detail ? "" : undefined}
            onClick={item.onSelect}
          >
            {text}
          </Link>
        ) : (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            className="pn-menu-item"
            data-danger={item.danger ? "" : undefined}
            data-detail={item.detail ? "" : undefined}
            disabled={item.disabled}
            onClick={item.onSelect}
          >
            {text}
          </button>
        );
      })}
    </div>
  );
}
