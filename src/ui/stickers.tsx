"use client";

import type { CSSProperties, ElementType, ReactNode } from "react";
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
  const tag = <span className="pn-pin-tag">{label}</span>;
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

/** "Made from": every thing in a scene with its sticker and owner, plus the remix source. */
export function CreditLine({
  items,
  label = t("en", "ui.madeFrom"),
  remixOf,
  onItem,
  className,
}: {
  items: Credit[];
  label?: string;
  remixOf?: { title: string; owner?: string } | null;
  onItem?: (item: Credit, index: number) => void;
  className?: string;
}) {
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
      {remixOf ? (
        <p className="pn-credit-remix">
          {t("en", "ui.remixOf")} <b>{remixOf.title}</b>
          {remixOf.owner ? ` ${t("en", "ui.by")} ${remixOf.owner}` : null}
        </p>
      ) : null}
    </div>
  );
}
