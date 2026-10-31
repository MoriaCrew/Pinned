"use client";

import type { CSSProperties, ReactNode } from "react";
import type { RemixSource } from "../domain/board-ui";
import { stickerTilt } from "../domain/skins";
import { t, tf } from "../i18n";
import { useLocale } from "../i18n/client";
import { Button, IconButton, Tag, cx } from "./primitives";
import { CreditLine, type Credit } from "./stickers";

export type SceneKind = "scene" | "collage" | "remix";

/**
 * A scene as a print: the picture alone in its frame, then one small
 * row on the paper (Remix / Collage tag left, Nº right), the idea in
 * quotes, the compact credits row (PIN-130: stickers only, the full
 * list lives in the scene viewer), then Remix / Share / More. Nothing
 * sits on the picture, so it never covers a face. `onOpen` (PIN-131)
 * makes the picture (named by the idea) and the credits row buttons
 * that open the scene viewer. The skin draws the
 * print (white border, pinned card, film frame, stamp edges…).
 */
export function SceneCard({
  src,
  alt = "",
  idea,
  credits,
  kind = "scene",
  remixOf,
  ratio = "3 / 2",
  number,
  seed,
  tilt,
  onRemix,
  onShare,
  onMore,
  onOpen,
  remixLabel,
  sharing,
  footer,
  className,
}: {
  src: string;
  alt?: string;
  idea?: string;
  credits?: Credit[];
  kind?: SceneKind;
  remixOf?: RemixSource | null;
  ratio?: string;
  number?: number;
  seed?: string;
  tilt?: number;
  onRemix?: () => void;
  onShare?: () => void;
  onMore?: () => void;
  onOpen?: () => void;
  remixLabel?: string;
  /** Share in progress: the share control is disabled. */
  sharing?: boolean;
  /** Extra line under the actions (e.g. a share error). */
  footer?: ReactNode;
  className?: string;
}) {
  const locale = useLocale();
  const style = { "--t": tilt ?? stickerTilt(seed ?? idea ?? src) } as CSSProperties;
  const tag =
    kind === "collage" ? (
      <Tag tone="ink">{t(locale, "ui.collage")}</Tag>
    ) : kind === "remix" ? (
      <Tag tone="mark" icon="remix">
        {t(locale, "ui.remixTag")}
      </Tag>
    ) : null;
  const no =
    number !== undefined ? <span className="pn-print-no">{tf(locale, "ui.sceneNumber", { n: String(number).padStart(2, "0") })}</span> : null;
  const hasActions = Boolean(onRemix || onShare || onMore);
  const hasCredits = Boolean(credits && credits.length > 0);
  const hasBody = Boolean(idea || hasCredits || hasActions || footer);
  const frame = (
    <div className="pn-print-frame" style={{ aspectRatio: ratio }}>
      <img src={src} alt={alt} loading="lazy" />
    </div>
  );
  return (
    <article
      className={cx("pn-print-wrap", className)}
      style={style}
      aria-label={idea ? tf(locale, "ui.sceneLabel", { idea }) : t(locale, "ui.scene")}
    >
      <div className="pn-print">
        {onOpen ? (
          <button type="button" className="pn-print-open" aria-label={idea || t(locale, "ui.scene")} aria-haspopup="dialog" onClick={onOpen}>
            {frame}
          </button>
        ) : (
          frame
        )}
        {tag || no ? (
          <div className="pn-print-meta">
            {tag}
            {no}
          </div>
        ) : null}
        {hasBody ? (
          <div className="pn-print-body">
            {idea ? <p className="pn-print-idea">{tf(locale, "ui.quoted", { text: idea })}</p> : null}
            {hasCredits ? <CreditLine compact items={credits ?? []} remixOf={remixOf} onOpen={onOpen} /> : null}
            {hasActions ? (
              <div className="pn-print-actions">
                {onRemix ? (
                  <Button variant="secondary" size="sm" icon="remix" onClick={onRemix}>
                    {remixLabel ?? t(locale, "ui.remix")}
                  </Button>
                ) : null}
                <span className="pn-spacer" />
                {onShare ? <IconButton icon="share" label={t(locale, "ui.shareScene")} variant="ghost" onClick={onShare} disabled={sharing} /> : null}
                {onMore ? <IconButton icon="more" label={t(locale, "ui.more")} variant="ghost" onClick={onMore} /> : null}
              </div>
            ) : null}
            {footer}
          </div>
        ) : null}
      </div>
    </article>
  );
}

const ROUGH_CUT: [number, number][][] = [
  [[50, 52]],
  [[36, 56], [64, 44]],
  [[30, 60], [52, 38], [72, 62]],
  [[30, 38], [68, 34], [34, 70], [70, 68]],
];

/**
 * The scene while the image model works: the picked stickers in a
 * rough layout on a dark print that slowly develops. Put it where
 * the scene will land and swap it for the SceneCard in place.
 */
export function Developing({
  stickers,
  idea,
  elapsed,
  line,
  statusLabel,
  ratio = "3 / 2",
  footer,
  className,
}: {
  stickers: { src: string; seed?: string }[];
  idea?: string;
  elapsed?: string;
  line?: string;
  statusLabel?: string;
  ratio?: string;
  footer?: ReactNode;
  className?: string;
}) {
  const locale = useLocale();
  const cuts = stickers.slice(0, 4);
  const spots = ROUGH_CUT[Math.max(0, cuts.length - 1)] ?? ROUGH_CUT[0];
  return (
    <article
      className={cx("pn-print-wrap", className)}
      style={{ "--t": 0 } as CSSProperties}
      role="status"
      aria-live="polite"
      aria-label={idea ? tf(locale, "ui.makingSceneLabel", { idea }) : t(locale, "ui.makingScene")}
    >
      <div className="pn-print">
        <div className="pn-develop-frame pn-print-frame" style={{ aspectRatio: ratio }}>
          {cuts.map((cut, i) => (
            <img
              key={`${cut.src}-${i}`}
              className="pn-develop-cut"
              src={cut.src}
              alt=""
              style={
                {
                  left: `${spots[i][0]}%`,
                  top: `${spots[i][1]}%`,
                  "--t": stickerTilt(cut.seed ?? cut.src),
                  animationDelay: `${i * -0.8}s`,
                } as CSSProperties
              }
            />
          ))}
        </div>
        <div className="pn-print-body">
          <div className="pn-develop-status">
            <Tag tone="ink">{statusLabel ?? t(locale, "ui.developing")}</Tag>
            {elapsed ? <span className="pn-board-meta">{elapsed}</span> : null}
          </div>
          {idea ? <p className="pn-print-idea">{tf(locale, "ui.quoted", { text: idea })}</p> : null}
          <p className="pn-develop-line">{line ?? t(locale, "ui.developingLine")}</p>
          {footer}
        </div>
      </div>
    </article>
  );
}
