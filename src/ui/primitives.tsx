"use client";

import { useId, useState, type AnchorHTMLAttributes, type ButtonHTMLAttributes, type ChangeEvent, type CSSProperties, type ReactNode } from "react";
import { personColorIndex } from "../domain/skins";
import { t, tCount, tf } from "../i18n";
import { useLocale } from "../i18n/client";
import { DEFAULT_LOCALE, type Locale } from "../i18n/locales";
import { Icon, type IconName } from "./icons";

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

/* ---------- Wordmark ---------- */

/** Lowercase "pinneds", the i dotted with the skin's pin colour. */
export function Wordmark({ size = 28, href, className }: { size?: number | string; href?: string; className?: string }) {
  const locale = useLocale();
  const style = { fontSize: typeof size === "number" ? `${size}px` : size };
  const letters = (
    <span aria-hidden="true">
      p
      <span className="pn-wm-i">
        {"ı"}
        <span className="pn-wm-dot" />
      </span>
      nneds
    </span>
  );
  if (href) {
    return (
      <a className={cx("pn-wordmark", className)} href={href} style={style} aria-label={t(locale, "ui.home")}>
        {letters}
      </a>
    );
  }
  return (
    <span className={cx("pn-wordmark", className)} style={style} role="img" aria-label="Pinneds">
      {letters}
    </span>
  );
}

/* ---------- Button ---------- */

export type ButtonVariant = "primary" | "secondary" | "quiet";
export type ButtonSize = "sm" | "md" | "lg";

interface ButtonOwnProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName;
  iconEnd?: IconName;
  block?: boolean;
  children?: ReactNode;
}

function buttonClass(variant: ButtonVariant, size: ButtonSize, block: boolean | undefined, className?: string) {
  return cx("pn-btn", `pn-btn-${variant}`, size !== "md" && `pn-btn-${size}`, block && "pn-btn-block", className);
}

/** A labelled action: verb first, at most three words. One primary per view. */
export function Button({
  variant = "secondary",
  size = "md",
  icon,
  iconEnd,
  block,
  className,
  children,
  type = "button",
  ...rest
}: ButtonOwnProps & ButtonHTMLAttributes<HTMLButtonElement>) {
  const iconSize = size === "lg" ? 22 : 20;
  return (
    <button {...rest} type={type} className={buttonClass(variant, size, block, className)}>
      {icon ? <Icon name={icon} size={iconSize} /> : null}
      {children}
      {iconEnd ? <Icon name={iconEnd} size={iconSize} /> : null}
    </button>
  );
}

/** Same look as Button, for navigation. */
export function ButtonLink({
  variant = "secondary",
  size = "md",
  icon,
  iconEnd,
  block,
  className,
  children,
  ...rest
}: ButtonOwnProps & AnchorHTMLAttributes<HTMLAnchorElement>) {
  const iconSize = size === "lg" ? 22 : 20;
  return (
    <a {...rest} className={buttonClass(variant, size, block, className)}>
      {icon ? <Icon name={icon} size={iconSize} /> : null}
      {children}
      {iconEnd ? <Icon name={iconEnd} size={iconSize} /> : null}
    </a>
  );
}

/* ---------- IconButton ---------- */

/** Only for close, share and more; always carries a spoken label. */
export function IconButton({
  icon,
  label,
  variant = "raised",
  size = 22,
  className,
  type = "button",
  ...rest
}: {
  icon: IconName;
  label: string;
  variant?: "raised" | "ghost" | "accent";
  size?: number;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children">) {
  return (
    <button
      {...rest}
      type={type}
      className={cx("pn-iconbtn", variant !== "raised" && `pn-iconbtn-${variant}`, className)}
      aria-label={label}
      title={label}
    >
      <Icon name={icon} size={size} />
    </button>
  );
}

/* ---------- Chip ---------- */

/** Tap-to-fill idea pill, optionally with a sticker thumbnail; `selected` makes it a toggle. */
export function Chip({
  selected,
  thumb,
  icon,
  className,
  children,
  type = "button",
  ...rest
}: {
  selected?: boolean;
  thumb?: string;
  icon?: IconName;
  children?: ReactNode;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...rest}
      type={type}
      className={cx("pn-chip", className)}
      aria-pressed={selected === undefined ? undefined : selected}
    >
      {thumb ? (
        // eslint-disable-next-line @next/next/no-img-element -- board-link-checked cut-out
        <img className="pn-chip-thumb" src={thumb} alt="" />
      ) : icon ? (
        <Icon name={icon} size={18} />
      ) : null}
      {children}
      {selected ? <Icon name="check" size={18} /> : null}
    </button>
  );
}

/* ---------- Tag ---------- */

export type TagTone = "neutral" | "ink" | "mark" | "accent" | "outline";

/** One or two uppercase mono words that label something. */
export function Tag({ tone = "neutral", icon, className, children }: { tone?: TagTone; icon?: IconName; className?: string; children: ReactNode }) {
  return (
    <span className={cx("pn-tag", `pn-tag-${tone}`, className)}>
      {icon ? <Icon name={icon} size={12} strokeWidth={2.5} /> : null}
      {children}
    </span>
  );
}

/* ---------- Avatar ---------- */

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0] ? [...parts[0]][0] ?? "" : "?";
  const last = parts.length > 1 ? [...parts[parts.length - 1]][0] ?? "" : "";
  return (first + last).toUpperCase() || "?";
}

export interface Person {
  id: string;
  name: string;
  src?: string;
}

/** Initials on the person's stable colour (or their photo). Decorative unless `label` is set. */
export function Avatar({
  id,
  name,
  src,
  size = "md",
  label,
  className,
}: {
  id?: string;
  name: string;
  src?: string;
  size?: "sm" | "md" | "lg" | "dot";
  label?: string;
  className?: string;
}) {
  const n = personColorIndex(id ?? name);
  const style = { "--pc": `var(--person-${n})` } as CSSProperties;
  return (
    <span
      className={cx("pn-avatar", size !== "md" && `pn-avatar-${size}`, className)}
      style={style}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element -- profile photo
        <img src={src} alt="" />
      ) : size === "dot" ? null : (
        initials(name)
      )}
    </span>
  );
}

/** Who's on the board, as overlapping avatars with a "+n". `sm` sits inline on the meta line. */
export function AvatarStack({
  people,
  max = 4,
  size = "md",
  label,
  className,
}: {
  people: Person[];
  max?: number;
  size?: "sm" | "md";
  /** Spoken name of the stack (default: the count and every name). */
  label?: string;
  className?: string;
}) {
  const shown = people.slice(0, max);
  const extra = people.length - shown.length;
  const locale = useLocale();
  const spoken =
    label ??
    tf(locale, "ui.peopleNamed", {
      count: tCount(locale, "meta.people", people.length),
      names: people.map((p) => p.name).join(", "),
    });
  return (
    <span className={cx("pn-avatars", size === "sm" && "pn-avatars-sm", className)} role="img" aria-label={spoken}>
      {shown.map((p) => (
        <Avatar key={p.id} id={p.id} name={p.name} src={p.src} size={size} />
      ))}
      {extra > 0 ? (
        <span className="pn-avatar pn-avatars-more" aria-hidden="true">
          +{extra}
        </span>
      ) : null}
    </span>
  );
}

/* ---------- TextField ---------- */

/** Big plain field: label above, optional count, one-line help or error below. */
export function TextField({
  label,
  value,
  defaultValue,
  placeholder,
  multiline,
  rows = 3,
  maxLength,
  softMaxLength,
  help,
  error,
  id,
  name,
  required,
  autoComplete = "off",
  inputMode,
  enterKeyHint,
  onChange,
  className,
}: {
  label: string;
  value?: string;
  defaultValue?: string;
  placeholder?: string;
  multiline?: boolean;
  rows?: number;
  maxLength?: number;
  /**
   * Shows the "n/limit" count (code points) but sets no native
   * `maxlength`, which counts UTF-16 units and stops emoji early.
   * The caller enforces the limit with its own check.
   */
  softMaxLength?: number;
  help?: string;
  error?: string;
  id?: string;
  name?: string;
  required?: boolean;
  autoComplete?: string;
  inputMode?: "text" | "numeric";
  enterKeyHint?: "done" | "go" | "next" | "send";
  onChange?: (value: string, event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
  className?: string;
}) {
  const autoId = useId();
  const fieldId = id ?? autoId;
  const helpId = `${fieldId}-help`;
  // Uncontrolled fields keep their own copy so the count follows typing.
  const [uncontrolled, setUncontrolled] = useState(defaultValue ?? "");
  const current = value ?? uncontrolled;
  const length = [...current].length;
  const limit = maxLength ?? softMaxLength;
  const count = limit ? `${length}/${limit}` : null;
  const shared = {
    id: fieldId,
    name,
    className: "pn-input",
    value,
    defaultValue,
    placeholder,
    maxLength,
    required,
    autoComplete,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": help || error ? helpId : undefined,
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (value === undefined) setUncontrolled(event.target.value);
      onChange?.(event.target.value, event);
    },
  };
  return (
    <div className={cx("pn-field", className)} data-invalid={error ? "" : undefined}>
      <label className="pn-field-label" htmlFor={fieldId}>
        {label}
      </label>
      {multiline ? (
        <textarea {...shared} rows={rows} enterKeyHint={enterKeyHint} />
      ) : (
        <input {...shared} inputMode={inputMode} enterKeyHint={enterKeyHint} />
      )}
      {help || error || count ? (
        <div className="pn-field-foot">
          {error ? (
            <span id={helpId} className="pn-field-error" role="alert">
              <Icon name="info" size={16} />
              {error}
            </span>
          ) : (
            <span id={helpId}>{help ?? ""}</span>
          )}
          {count ? <span className="pn-field-count">{count}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

/* ---------- Hint ---------- */

/** One coach mark at a time, inverted colours, pointing at what to do next. */
export function Hint({
  children,
  onDismiss,
  dismissLabel,
  point = "down",
  x,
  className,
}: {
  children: ReactNode;
  onDismiss?: () => void;
  dismissLabel?: string;
  point?: "down" | "up" | "none";
  x?: number | string;
  className?: string;
}) {
  const locale = useLocale();
  const style = x === undefined ? undefined : ({ "--hint-x": typeof x === "number" ? `${x}px` : x } as CSSProperties);
  return (
    <div className={cx("pn-hint", className)} role="status" data-point={point} style={style}>
      <p>{children}</p>
      {onDismiss ? (
        <Button variant="quiet" onClick={onDismiss}>
          {dismissLabel ?? t(locale, "ui.gotIt")}
        </Button>
      ) : null}
    </div>
  );
}

/** "2 of 4 picked" etc. — kept here so screens share one formatter. */
export function pickedCountLabel(n: number, max: number, locale: Locale = DEFAULT_LOCALE): string {
  return tf(locale, "ui.pickedCount", { n, max });
}
