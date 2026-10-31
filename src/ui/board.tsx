"use client";

import Link from "next/link";
import { useEffect, useId, useRef, type CSSProperties, type ReactNode } from "react";
import { t, tCount, tf } from "../i18n";
import { useLocale } from "../i18n/client";
import { DEFAULT_LOCALE, type Locale } from "../i18n/locales";
import { Avatar, AvatarStack, Button, IconButton, Wordmark, cx, pickedCountLabel, type Person } from "./primitives";

export interface BoardCounts {
  people?: number;
  things?: number;
  scenes?: number;
}

/** "6 people · 14 things · 6 scenes" (only the counts given). */
export function boardMetaLine(counts: BoardCounts, locale: Locale = DEFAULT_LOCALE): string {
  const parts: string[] = [];
  if (counts.people !== undefined) parts.push(tCount(locale, "meta.people", counts.people));
  if (counts.things !== undefined) parts.push(tCount(locale, "meta.things", counts.things));
  if (counts.scenes !== undefined) parts.push(tCount(locale, "meta.scenes", counts.scenes));
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
  shareLabel,
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
  const locale = useLocale();
  const meta = counts ? boardMetaLine(counts, locale) : "";
  const stack = people && people.length > 0 ? <AvatarStack people={people} max={3} size="sm" label={peopleLabel} /> : null;
  return (
    <header className={cx("pn-head", className)}>
      <div className="pn-head-row">
        <Wordmark size={22} href={homeHref} />
        <div className="pn-head-right">
          {onShare ? <IconButton icon="share" label={shareLabel ?? t(locale, "ui.shareBoard")} onClick={onShare} /> : null}
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

/** Section head on the board ("Scenes", "Things") with an optional mono count ("117", or "6 of 117"). */
/** `focusable`: the heading can take focus from script (tabIndex -1), e.g. after its last item goes. */
export function SectionHead({ title, count, id, focusable }: { title: string; count?: number | string; id?: string; focusable?: boolean }) {
  return (
    <div className="pn-section-head">
      <h2 className="pn-section-title" id={id} tabIndex={focusable ? -1 : undefined}>
        {title}
      </h2>
      {count !== undefined ? <span className="pn-board-meta">{count}</span> : null}
    </div>
  );
}

export interface FilterChipItem {
  id: string;
  /** Visible word or name; CSS cuts a long name short, the full one is spoken. */
  label: string;
  count: number;
  /** A person's chip leads with their colour dot. */
  person?: Person;
  /** "new": the count wears the mark colour. */
  tone?: "new";
}

/**
 * A sticky, sideways-scrolling row of toggle chips that narrows a
 * grid (PIN-218: New / All / Mine / people above the board's pins).
 * Each chip says its count and is spoken as "{name}, {n} pins".
 */
export function FilterChips({
  label,
  items,
  selectedId,
  onSelect,
  className,
}: {
  label: string;
  items: FilterChipItem[];
  selectedId: string;
  onSelect: (id: string) => void;
  className?: string;
}) {
  const locale = useLocale();
  const ref = useRef<HTMLDivElement>(null);
  // Keep the pressed chip in view (a restored choice can sit off to the side).
  useEffect(() => {
    const row = ref.current;
    const chip = row?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (!row || !chip) return;
    const start = chip.offsetLeft;
    const end = start + chip.offsetWidth;
    if (start < row.scrollLeft || end > row.scrollLeft + row.clientWidth) {
      row.scrollLeft = Math.max(0, start - (row.clientWidth - chip.offsetWidth) / 2);
    }
  }, [selectedId]);
  return (
    <div ref={ref} className={cx("pn-filter-row", className)} role="group" aria-label={label}>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          className="pn-chip pn-filter-chip"
          aria-pressed={item.id === selectedId}
          aria-label={tf(locale, "board.filterChip", { name: item.label, count: tCount(locale, "meta.things", item.count) })}
          data-tone={item.tone}
          onClick={() => onSelect(item.id)}
        >
          {item.person ? <Avatar id={item.person.id} name={item.person.name} size="dot" /> : null}
          <span className="pn-filter-name">{item.label}</span>
          <span className="pn-filter-count">{item.count}</span>
        </button>
      ))}
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
  const locale = useLocale();
  const cls = cx("pn-dock", props.fixed && "pn-dock-fixed", props.className);
  if (props.mode === "picking") {
    const slots = Array.from({ length: props.max }, (_, i) => props.picked[i] ?? null);
    return (
      <nav className={cls} aria-label={t(locale, "ui.pickedThings")}>
        <IconButton icon="close" label={props.cancelLabel ?? t(locale, "ui.stopPicking")} variant="ghost" onClick={props.onCancel} />
        <ol className="pn-tray" aria-label={t(locale, "ui.pickedThings")}>
          {slots.map((slot, i) => (
            <li key={i} className={cx("pn-tray-slot", slot && "is-filled")}>
              {slot ? (
                <img src={slot.src} alt={slot.label ?? ""} />
              ) : null}
            </li>
          ))}
        </ol>
        <span className="pn-sr" aria-live="polite">
          {pickedCountLabel(props.picked.length, props.max, locale)}
        </span>
        <Button
          variant="primary"
          size="lg"
          iconEnd="arrow"
          disabled={props.nextDisabled ?? props.picked.length === 0}
          onClick={props.onNext}
          style={{ flex: "0 0 auto" }}
        >
          {props.nextLabel ?? t(locale, "ui.next")}
        </Button>
      </nav>
    );
  }
  return (
    <nav className={cls} aria-label={t(locale, "ui.boardActions")}>
      <Button variant="primary" size="lg" icon="camera" onClick={props.onAdd}>
        {props.addLabel ?? t(locale, "ui.addPhoto")}
      </Button>
      <Button variant="secondary" size="lg" icon="scene" onClick={props.onMake} disabled={props.makeDisabled}>
        {props.makeLabel ?? t(locale, "ui.makeScene")}
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
  closeLabel,
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
  const locale = useLocale();
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
        {onClose ? <IconButton icon="close" label={closeLabel ?? t(locale, "ui.close")} variant="ghost" onClick={onClose} /> : null}
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
  title,
  body,
  actionLabel,
  shareLabel,
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
  const locale = useLocale();
  return (
    <section className={cx("pn-empty", className)}>
      <div className="pn-empty-ghosts" aria-hidden="true">
        <span className="pn-ghost" style={{ "--t": -0.8 } as CSSProperties} />
        <span className="pn-ghost pn-ghost-tall" style={{ "--t": 0.6 } as CSSProperties} />
        <span className="pn-ghost pn-ghost-wide" style={{ "--t": -0.3 } as CSSProperties} />
      </div>
      <h2 className="pn-section-title">{title ?? t(locale, "ui.emptyTitle")}</h2>
      <p className="pn-empty-body">{body ?? t(locale, "ui.emptyBody")}</p>
      <div className="pn-empty-actions">
        {onAction ? (
          <Button variant="primary" size="lg" icon="camera" onClick={onAction}>
            {actionLabel ?? t(locale, "ui.emptyAction")}
          </Button>
        ) : null}
        {onShare ? (
          <Button variant="secondary" size="lg" icon="share" onClick={onShare}>
            {shareLabel ?? t(locale, "ui.emptyShare")}
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
