"use client";

import type { CSSProperties, ElementType, ReactNode } from "react";
import type { RemixSource } from "../domain/board-ui";
import { stickerTilt } from "../domain/skins";
import { t, tf } from "../i18n";
import { Avatar, cx, type Person } from "./primitives";

export type StickerState = "rest" | "picked" | "dropped" | "arriving" | "cutting";

/**
 * A cut-out as a die-cut sticker: keyline, lift shadow and a tilt
 * that is stable for its seed. The skin decides keyline width,
 * shadow, tilt and the pushpin; never set them per screen.
 */
export function Sticker({
  src,
  alt = "",
  seed,
  tilt,
  state = "rest",
  pickIndex,
  size,
  foil,
  loading = "lazy",
  style,
  className,
}: {
  src: string;
  alt?: string;
  seed?: string;
  /** Override the seeded tilt factor (-1..1). */
  tilt?: number;
  state?: StickerState;
  pickIndex?: number;
  size?: number | string;
  foil?: boolean;
  loading?: "lazy" | "eager";
  style?: CSSProperties;
  className?: string;
}) {
  const vars: Record<string, string | number> = { "--t": tilt ?? stickerTilt(seed) };
  if (size !== undefined) vars["--pn-size"] = typeof size === "number" ? `${size}px` : size;
  if (state === "cutting" || foil) vars["--src"] = `url("${src}")`;
  return (
    <span
      className={cx("pn-sticker", className)}
      data-state={state}
      data-foil={foil ? "" : undefined}
      style={{ ...(vars as CSSProperties), ...style }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- board-link-checked cut-out */}
      <img src={src} alt={alt} draggable={false} loading={loading} />
      {foil ? <span className="pn-foil" aria-hidden="true" /> : null}
      {state === "picked" && pickIndex ? (
        <span className="pn-sticker-badge" aria-hidden="true">
          {pickIndex}
        </span>
      ) : null}
    </span>
  );
}

/**
 * A thing on the board: its sticker, its name tag, whose it is.
 * With `onToggle` it is a pick button (board picking mode, the Add
 * sheet's review step).
 */
export function Pin({
  src,
  label,
  owner,
  seed,
  state = "rest",
  pickIndex,
  size,
  foil,
  as: Root = "div",
  onToggle,
  pressedWhenRest,
  children,
  className,
}: {
  src: string;
  label: string;
  owner?: Person | null;
  seed?: string;
  state?: StickerState;
  pickIndex?: number;
  size?: number | string;
  foil?: boolean;
  as?: ElementType;
  onToggle?: () => void;
  /** Add sheet: everything starts kept, so rest = pressed. */
  pressedWhenRest?: boolean;
  /** Extra controls under the pin (e.g. a More menu for the owner). */
  children?: ReactNode;
  className?: string;
}) {
  const picked = state === "picked";
  const sticker = <Sticker src={src} seed={seed ?? label} state={state} pickIndex={pickIndex} size={size} foil={foil} />;
  const tag = (
    <span className="pn-pin-tag">
      <span className="pn-pin-tag-text">{label}</span>
    </span>
  );
  const who = owner ? (
    <span className="pn-pin-owner">
      <Avatar id={owner.id} name={owner.name} size="dot" />
      {owner.name}
    </span>
  ) : null;
  if (onToggle) {
    const parts = [owner ? tf("en", "ui.ownerThing", { owner: owner.name, thing: label }) : label];
    if (picked) parts.push(pickIndex ? tf("en", "ui.pickedN", { n: pickIndex }) : t("en", "ui.picked"));
    if (state === "dropped") parts.push(t("en", "ui.leftOut"));
    const pressed = picked || (Boolean(pressedWhenRest) && state !== "dropped");
    return (
      <Root className={cx("pn-pin", className)} data-state={state}>
        <button type="button" className="pn-pin-hit" aria-pressed={pressed} aria-label={parts.join(", ")} onClick={onToggle}>
          {sticker}
          {tag}
          {who}
        </button>
        {children}
      </Root>
    );
  }
  return (
    <Root className={cx("pn-pin", className)} data-state={state}>
      {sticker}
      {tag}
      {who}
      {children}
    </Root>
  );
}

export interface Credit {
  thing: string;
  owner?: Person | null;
  src?: string;
}

/**
 * Layout, not Policy (PIN-130): how many places one compact credit row
 * has. A sticker is `--avatar-lg` (40px) and each overlaps the last by
 * `--space-3`, so 6 places are 40 + 5 x 28 = 180px: they fit between the
 * paper borders of the narrowest print (about 190px at a 320px screen).
 * A scene can be made from any number of things; the ones that do not
 * fit fold into the "+N" tail and the viewer lists them all.
 */
export const COMPACT_CREDIT_SLOTS = 6;

/**
 * Which credits get a sticker in a row of `slots` places and how many
 * fold into the "+N" tail. The tail takes the last place, so the row is
 * never wider than `slots`, and it always stands for two or more things
 * (a single leftover gets its own sticker instead).
 */
export function splitCompactCredits<T>(items: readonly T[], slots: number): { shown: T[]; more: number } {
  if (items.length <= slots) return { shown: [...items], more: 0 };
  const shown = items.slice(0, Math.max(0, slots - 1));
  return { shown, more: items.length - shown.length };
}

/**
 * The compact row's accessible name: the label, then every thing
 * ("Made from teal mug, rubber duck and succulent"). The row shows
 * stickers only, so this is the one place the names are on the card.
 */
export function compactCreditsName(label: string, things: readonly string[]): string {
  if (things.length === 0) return label;
  const list =
    things.length === 1
      ? (things[0] ?? "")
      : tf("en", "ui.listAnd", { rest: things.slice(0, -1).join(", "), last: things[things.length - 1] ?? "" });
  return `${label} ${list}`;
}

/**
 * "Made from": every thing in a scene with its sticker and owner, plus
 * the remix source. `compact` is the print's form: the label over one
 * row of small overlapping stickers (a "+N" disc when the row is full),
 * then the remix line. That row is not a control: it is one image with
 * every name in its accessible name (a group holding only decorative
 * stickers would be skipped by touch screen readers). `onOpen` turns
 * it into one button, 44px or taller, for the scene viewer. `onItem`
 * belongs to the full list.
 */
export function CreditLine({
  items,
  label = t("en", "ui.madeFrom"),
  remixOf,
  onItem,
  compact,
  onOpen,
  className,
}: {
  items: Credit[];
  label?: string;
  remixOf?: RemixSource | null;
  onItem?: (item: Credit, index: number) => void;
  compact?: boolean;
  onOpen?: () => void;
  className?: string;
}) {
  const remix = !remixOf ? null : "deleted" in remixOf ? (
    <p className="pn-credit-remix">{t("en", "ui.remixOfDeleted")}</p>
  ) : (
    <p className="pn-credit-remix">
      {t("en", "ui.remixOf")} <b>{remixOf.title}</b>
      {remixOf.owner ? ` ${t("en", "ui.by")} ${remixOf.owner}` : null}
    </p>
  );
  if (compact) {
    const { shown, more } = splitCompactCredits(items, COMPACT_CREDIT_SLOTS);
    const name = compactCreditsName(
      label,
      items.map((item) => item.thing),
    );
    const content = (
      <>
        <span className="pn-credit-label">{label}</span>
        <span className="pn-credit-stack">
          {shown.map((item, index) =>
            item.src ? (
              // eslint-disable-next-line @next/next/no-img-element -- board-link-checked cut-out
              <img key={`${item.thing}-${index}`} className="pn-credit-dot" src={item.src} alt="" />
            ) : (
              <Avatar key={`${item.thing}-${index}`} id={item.owner?.id ?? item.thing} name={item.owner?.name ?? item.thing} size="lg" />
            ),
          )}
          {more > 0 ? <span className="pn-credit-more">{tf("en", "ui.creditsMore", { n: more })}</span> : null}
        </span>
      </>
    );
    return (
      <div className={cx("pn-credit", "pn-credit-compact", className)}>
        {items.length === 0 ? null : onOpen ? (
          <button type="button" className="pn-credit-row pn-credit-open" aria-label={name} aria-haspopup="dialog" onClick={onOpen}>
            {content}
          </button>
        ) : (
          <div className="pn-credit-row" role="img" aria-label={name}>
            {content}
          </div>
        )}
        {remix}
      </div>
    );
  }
  return (
    <div className={cx("pn-credit", className)}>
      <span className="pn-credit-label">{label}</span>
      <ul className="pn-credit-list">
        {items.map((item, index) => {
          const body = (
            <>
              {item.src ? (
                // eslint-disable-next-line @next/next/no-img-element -- board-link-checked cut-out
                <img src={item.src} alt="" />
              ) : item.owner ? (
                <Avatar id={item.owner.id} name={item.owner.name} />
              ) : null}
              <span>{item.thing}</span>
              {item.owner ? <span className="pn-credit-who">{item.owner.name}</span> : null}
            </>
          );
          return (
            <li key={`${item.thing}-${index}`}>
              {onItem ? (
                <button
                  type="button"
                  className="pn-credit-item"
                  onClick={() => onItem(item, index)}
                  aria-label={item.owner ? tf("en", "ui.ownerThing", { owner: item.owner.name, thing: item.thing }) : item.thing}
                >
                  {body}
                </button>
              ) : (
                <span className="pn-credit-item">{body}</span>
              )}
            </li>
          );
        })}
      </ul>
      {remix}
    </div>
  );
}
