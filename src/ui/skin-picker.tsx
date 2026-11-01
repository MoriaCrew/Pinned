"use client";

import type { CSSProperties } from "react";
import { formatEur } from "../domain/makes-ui";
import { getSkin, type SkinId } from "../domain/skins";
import { t, tCount, tf, type Locale, type MessageKey } from "../i18n";
import { useLocale } from "../i18n/client";
import { DEFAULT_LOCALE } from "../i18n/locales";
import { Icon, type IconName } from "./icons";
import { Button, Tag, cx } from "./primitives";
import { Sticker } from "./stickers";
import { Sheet } from "./board";

export function skinName(id: SkinId, locale: Locale = DEFAULT_LOCALE): string {
  return t(locale, `skin.${id}` as MessageKey);
}

export function skinMood(id: SkinId, locale: Locale = DEFAULT_LOCALE): string {
  return t(locale, `skin.${id}.mood` as MessageKey);
}

export interface SkinOption {
  id: SkinId;
  /** Spark's (or the heuristic's) pick for this board: shows "For you". */
  suggested?: boolean;
  /** Plus skin this board has not bought yet: shows a lock (try-on still allowed). */
  locked?: boolean;
}

const MINI: { left: string; top: string; size: string }[] = [
  { left: "6%", top: "40%", size: "50%" },
  { left: "46%", top: "30%", size: "48%" },
  { left: "24%", top: "62%", size: "44%" },
];

/**
 * Choose a look by seeing it: a radio group of mini boards, each in
 * its own skin, wearing three of the board's own stickers.
 */
export function SkinPicker({
  skins,
  value,
  onChange,
  sample = [],
  name = "skin",
  legend,
  className,
}: {
  skins: SkinOption[];
  value: SkinId;
  onChange: (id: SkinId) => void;
  /** Up to three cut-out URLs to show on every mini board. */
  sample?: string[];
  name?: string;
  legend?: string;
  className?: string;
}) {
  const locale = useLocale();
  return (
    <fieldset className={cx("pn-skins", className)}>
      <legend className="pn-sr">{legend ?? t(locale, "ui.look")}</legend>
      {skins.map((option) => {
        const plus = getSkin(option.id).plus;
        return (
          <label key={option.id} className="pn-skin">
            <input
              type="radio"
              name={name}
              value={option.id}
              checked={value === option.id}
              onChange={() => onChange(option.id)}
            />
            <span className="pn-skin-board" data-theme={option.id} aria-hidden="true">
              <span className="pn-skin-band" />
              <span className="pn-skin-aa">Aa</span>
              <span className="pn-skin-dot" />
              {sample.slice(0, 3).map((src, i) => (
                <Sticker
                  key={`${src}-${i}`}
                  src={src}
                  seed={`${option.id}-${i}`}
                  size={MINI[i].size}
                  loading="eager"
                  style={{ left: MINI[i].left, top: MINI[i].top } as CSSProperties}
                />
              ))}
              <span className="pn-skin-check">
                <Icon name="check" size={16} strokeWidth={2.5} />
              </span>
            </span>
            <span className="pn-skin-name">
              {skinName(option.id, locale)}
              {plus ? (
                <Tag tone="outline" icon={option.locked ? "lock" : undefined}>
                  {t(locale, "ui.plus")}
                </Tag>
              ) : null}
              {option.suggested ? <Tag tone="mark">{t(locale, "ui.forYou")}</Tag> : null}
            </span>
            <span className="pn-skin-mood">{skinMood(option.id, locale)}</span>
          </label>
        );
      })}
    </fieldset>
  );
}

/** "Trying on <b>skin</b>" as one sentence; split around the placeholder to keep the name bold. */
function tryingOnLine(locale: Locale, skin: string) {
  const [before = "", after = ""] = t(locale, "ui.tryingOnSkin").split("{skin}");
  return (
    <>
      {before}
      <b>{skin}</b>
      {after}
    </>
  );
}

/** Shown while someone tries a Plus skin on their real board. */
export function TryOnBar({
  skin,
  onUndo,
  onKeep,
  className,
}: {
  skin: SkinId;
  onUndo?: () => void;
  onKeep?: () => void;
  className?: string;
}) {
  const locale = useLocale();
  return (
    <div className={cx("pn-tryon", className)} role="status">
      <Tag tone="outline" icon="lock">
        {t(locale, "ui.plus")}
      </Tag>
      <p>
        {tryingOnLine(locale, skinName(skin, locale))}
      </p>
      <Button variant="quiet" onClick={onUndo}>
        {t(locale, "ui.undo")}
      </Button>
      <Button variant="primary" size="sm" onClick={onKeep}>
        {t(locale, "ui.keepIt")}
      </Button>
    </div>
  );
}

/** The one pack the sheet sells, as Policy offers it (`Policy.credits.packs[0]`). */
export interface PlusPack {
  credits: number;
  eurCents: number;
}

interface Perk {
  icon?: IconName;
  foil?: boolean;
  soon?: boolean;
  title: string;
  body?: string;
}

/**
 * The one screen that asks for money (docs/15, PIN-182): Board Plus
 * and its creations as a single purchase for the board. Anyone on
 * the board can buy it; everyone on it gets the perks. The price is
 * formatted from the Policy pack, never a label. `available=false`
 * (billing off) says "Coming soon" and charges nothing; with Plus
 * already on, the sheet only adds creations.
 */
export function PlusSheet({
  pack,
  plusActive,
  available,
  lockedLine = null,
  paymentNote = false,
  busy = false,
  error = null,
  foilSrc,
  onGet,
  onClose,
  layer = "fixed",
}: {
  pack: PlusPack | null;
  /** The board already has Plus: the sheet only adds creations. */
  plusActive: boolean;
  /** Buying can work in this mode; false shows Coming soon and sells nothing. */
  available: boolean;
  /** The button shows but cannot be pressed; this line says why (a guest in the demo). */
  lockedLine?: string | null;
  /** A real checkout follows (stripe): one quiet line about the local currency and the statement name. */
  paymentNote?: boolean;
  busy?: boolean;
  /** A checkout error, already worded; announced when it appears. */
  error?: string | null;
  foilSrc?: string;
  onGet?: () => void;
  onClose?: () => void;
  layer?: "fixed" | "absolute" | "none";
}) {
  const locale = useLocale();
  const offer = available ? pack : null;
  // `soon`: planned, not built yet. The sheet says so instead of
  // promising it (docs/15: the demo stays honest).
  const perks: Perk[] = [];
  if (pack) {
    perks.push({
      icon: "plus",
      title: tCount(locale, "ui.plusPerkCreations", pack.credits),
      body: t(locale, "ui.plusPerkCreationsBody"),
    });
  }
  if (plusActive) {
    // Plus is already on, so its photo limit is already gone: the sheet
    // only sells creations, and "Plus is on" stands for every perk.
    perks.push({ icon: "check", title: t(locale, "ui.plusIsOn") });
  } else {
    perks.push(
      // PIN-231: a board without Plus has free photos; Plus has no limit.
      { icon: "camera", title: t(locale, "ui.plusPerkPhotos"), body: t(locale, "ui.plusPerkPhotosBody") },
      { icon: "skin", title: t(locale, "ui.plusPerkSkins"), body: t(locale, "ui.plusPerkSkinsBody") },
      { foil: true, title: t(locale, "ui.plusPerkFoil"), body: t(locale, "ui.plusPerkFoilBody") },
      { icon: "scene", soon: true, title: t(locale, "ui.plusPerkScenes"), body: t(locale, "ui.plusPerkScenesBody") },
      { icon: "download", soon: true, title: t(locale, "ui.plusPerkDownloads"), body: t(locale, "ui.plusPerkDownloadsBody") },
    );
  }
  // Whole sentences with placeholders (PIN-194), never glued fragments.
  const price = offer ? formatEur(offer.eurCents, locale) : "";
  const addKey = offer
    ? (`ui.plusAddPrice.${new Intl.PluralRules(locale).select(offer.credits) === "one" ? "one" : "other"}` as MessageKey)
    : null;
  const cta = busy
    ? t(locale, "makes.buying")
    : offer
      ? plusActive && addKey
        ? tf(locale, addKey, { n: offer.credits, price })
        : tf(locale, "ui.plusGetPrice", { price })
      : t(locale, "ui.plusSoon");
  const line = !offer ? t(locale, "ui.plusSoonLine") : lockedLine ?? (plusActive ? null : t(locale, "ui.plusOnce"));
  return (
    <Sheet
      title={t(locale, "ui.plusTitle")}
      closeLabel={t(locale, "ui.close")}
      onClose={onClose}
      layer={layer}
      footer={
        <>
          <Button variant="primary" size="lg" block disabled={!offer || busy || lockedLine !== null} onClick={() => onGet?.()}>
            {cta}
          </Button>
          {line ? <p className="pn-plus-soon">{line}</p> : null}
          {offer && paymentNote ? <p className="pn-plus-soon">{t(locale, "ui.plusPayNote")}</p> : null}
          {error ? (
            <p className="pn-plus-error" role="alert">
              {error}
            </p>
          ) : null}
          <Button variant="quiet" block onClick={onClose}>
            {t(locale, "ui.notNow")}
          </Button>
        </>
      }
    >
      <p className="pn-plus-lead">{t(locale, plusActive ? "makes.lead" : "ui.plusLead")}</p>
      <ul className="pn-perks">
        {perks.map((perk) => (
          <li key={perk.title}>
            {perk.foil && foilSrc ? (
              <Sticker src={foilSrc} seed="foil" size={44} foil loading="eager" />
            ) : (
              <span className="pn-perk-icon">
                <Icon name={perk.icon ?? "skin"} size={22} />
              </span>
            )}
            <span>
              <b>
                {perk.title}
                {perk.soon ? <Tag className="pn-perk-soon">{t(locale, "ui.perkSoon")}</Tag> : null}
              </b>
              {perk.body ? <small>{perk.body}</small> : null}
            </span>
          </li>
        ))}
      </ul>
    </Sheet>
  );
}
