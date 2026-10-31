"use client";

import { useId, type CSSProperties } from "react";
import { getSkin, type SkinId } from "../domain/skins";
import { t, tf, type MessageKey } from "../i18n";
import { useLocale } from "../i18n/client";
import { DEFAULT_LOCALE, type Locale } from "../i18n/locales";
import { Icon } from "./icons";
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

export type PlusPlan = "board" | "host";

export interface PlusPrices {
  /** Display label for the one-time board plan, e.g. "$3.99" (Policy). */
  board: string;
  /** Display label for the monthly host plan, e.g. "$4.99" (Policy). */
  host: string;
}

/**
 * The one screen that asks for money. Bought by whoever made the
 * board; everyone on it gets the perks. `available=false` (billing
 * off) shows the plans honestly with "Coming soon" and charges
 * nothing.
 */
export function PlusSheet({
  plan,
  onPlanChange,
  prices,
  available,
  busy,
  foilSrc,
  onGet,
  onClose,
  layer = "fixed",
}: {
  plan: PlusPlan;
  onPlanChange: (plan: PlusPlan) => void;
  prices: PlusPrices;
  available: boolean;
  busy?: boolean;
  foilSrc?: string;
  onGet?: (plan: PlusPlan) => void;
  onClose?: () => void;
  layer?: "fixed" | "absolute" | "none";
}) {
  // `soon`: planned, not built yet. The sheet says so instead of
  // promising it (docs/15: the demo stays honest).
  const perks: { icon?: "skin" | "scene" | "download"; foil?: boolean; soon?: boolean; title: MessageKey; body: MessageKey }[] = [
    { icon: "skin", title: "ui.plusPerkSkins", body: "ui.plusPerkSkinsBody" },
    { foil: true, title: "ui.plusPerkFoil", body: "ui.plusPerkFoilBody" },
    { icon: "scene", soon: true, title: "ui.plusPerkScenes", body: "ui.plusPerkScenesBody" },
    { icon: "download", soon: true, title: "ui.plusPerkDownloads", body: "ui.plusPerkDownloadsBody" },
  ];
  const locale = useLocale();
  const price = plan === "board" ? prices.board : prices.host;
  // One radio group per sheet: two open sheets never share a name.
  const planGroup = `plus-plan-${useId()}`;
  return (
    <Sheet
      title={t(locale, "ui.plusTitle")}
      onClose={onClose}
      layer={layer}
      footer={
        <>
          <Button
            variant="primary"
            size="lg"
            block
            disabled={!available || busy}
            onClick={() => onGet?.(plan)}
          >
            {available ? tf(locale, "ui.plusGetPrice", { price }) : t(locale, "ui.plusSoon")}
          </Button>
          {!available ? <p className="pn-plus-soon">{t(locale, "ui.plusSoonLine")}</p> : null}
          <Button variant="quiet" block onClick={onClose}>
            {t(locale, "ui.notNow")}
          </Button>
        </>
      }
    >
      <p className="pn-plus-lead">{t(locale, "ui.plusLead")}</p>
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
                {t(locale, perk.title)}
                {perk.soon ? <Tag className="pn-perk-soon">{t(locale, "ui.perkSoon")}</Tag> : null}
              </b>
              <small>{t(locale, perk.body)}</small>
            </span>
          </li>
        ))}
      </ul>
      <fieldset className="pn-plans">
        <legend className="pn-sr">{t(locale, "ui.plusPlans")}</legend>
        {(["board", "host"] as const).map((id) => (
          <label key={id} className="pn-plan">
            <input type="radio" name={planGroup} value={id} checked={plan === id} onChange={() => onPlanChange(id)} />
            <span className="pn-plan-name">{t(locale, id === "board" ? "ui.plusPlanBoard" : "ui.plusPlanHost")}</span>
            <span className="pn-plan-price">{id === "board" ? prices.board : prices.host}</span>
            <span className="pn-plan-note">{t(locale, id === "board" ? "ui.plusPlanBoardNote" : "ui.plusPlanHostNote")}</span>
            <span className="pn-plan-check" aria-hidden="true">
              <Icon name="check" size={14} strokeWidth={2.5} />
            </span>
          </label>
        ))}
      </fieldset>
    </Sheet>
  );
}
