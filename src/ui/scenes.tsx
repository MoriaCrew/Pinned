"use client";

import type { CSSProperties, ReactNode } from "react";
import { stickerTilt } from "../domain/skins";
import { t, tf } from "../i18n";
import { Button, IconButton, Tag, cx } from "./primitives";
import { CreditLine, type Credit } from "./stickers";

export type SceneKind = "scene" | "collage" | "remix";

/**
 * A scene as a print: image, the idea in quotes, credits, then
 * Remix / Share / More. The skin draws the print (white border,
 * pinned card, film frame, stamp edges…).
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
  onCredit,
  remixLabel = t("en", "ui.remix"),
  sharing,
  footer,
  className,
}: {
  src: string;
  alt?: string;
  idea?: string;
  credits?: Credit[];
  kind?: SceneKind;
  remixOf?: { title: string; owner?: string } | null;
  ratio?: string;
  number?: number;
  seed?: string;
  tilt?: number;
  onRemix?: () => void;
  onShare?: () => void;
  onMore?: () => void;
  onCredit?: (item: Credit, index: number) => void;
  remixLabel?: string;
  /** Share in progress: the share control is disabled. */
  sharing?: boolean;
  /** Extra line under the actions (e.g. a share error). */
  footer?: ReactNode;
  className?: string;
}) {
  const style = { "--t": tilt ?? stickerTilt(seed ?? idea ?? src) } as CSSProperties;
  const tag =
    kind === "collage" ? (
      <Tag tone="ink" className="pn-print-kind">
        {t("en", "ui.collage")}
      </Tag>
    ) : kind === "remix" ? (
      <Tag tone="mark" icon="remix" className="pn-print-kind">
        {t("en", "ui.remixTag")}
      </Tag>
    ) : null;
  const hasActions = Boolean(onRemix || onShare || onMore);
  const hasCredits = Boolean(credits && credits.length > 0);
  const hasBody = Boolean(idea || hasCredits || hasActions || footer);
  return (
    <article
      className={cx("pn-print-wrap", className)}
      style={style}
      aria-label={idea ? `${t("en", "ui.scene")}: ${idea}` : t("en", "ui.scene")}
    >
      <div className="pn-print">
        <div className="pn-print-frame" style={{ aspectRatio: ratio }}>
          {/* eslint-disable-next-line @next/next/no-img-element -- board-link-checked scene image */}
          <img src={src} alt={alt} loading="lazy" />
          {tag}
          {number !== undefined ? <span className="pn-print-no">{tf("en", "ui.sceneNumber", { n: String(number).padStart(2, "0") })}</span> : null}
        </div>
        {hasBody ? (
          <div className="pn-print-body">
            {idea ? <p className="pn-print-idea">{`“${idea}”`}</p> : null}
            {hasCredits ? <CreditLine items={credits ?? []} remixOf={remixOf} onItem={onCredit} /> : null}
            {hasActions ? (
              <div className="pn-print-actions">
                {onRemix ? (
                  <Button variant="secondary" size="sm" icon="remix" onClick={onRemix}>
                    {remixLabel}
                  </Button>
                ) : null}
                <span className="pn-spacer" />
                {onShare ? <IconButton icon="share" label={t("en", "ui.shareScene")} variant="ghost" onClick={onShare} disabled={sharing} /> : null}
                {onMore ? <IconButton icon="more" label={t("en", "ui.more")} variant="ghost" onClick={onMore} /> : null}
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
  line = t("en", "ui.developingLine"),
  statusLabel = t("en", "ui.developing"),
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
  const cuts = stickers.slice(0, 4);
  const spots = ROUGH_CUT[Math.max(0, cuts.length - 1)] ?? ROUGH_CUT[0];
  return (
    <article
      className={cx("pn-print-wrap", className)}
      style={{ "--t": 0 } as CSSProperties}
      role="status"
      aria-live="polite"
      aria-label={idea ? `${t("en", "ui.makingScene")}: ${idea}` : t("en", "ui.makingScene")}
    >
      <div className="pn-print">
        <div className="pn-develop-frame pn-print-frame" style={{ aspectRatio: ratio }}>
          {cuts.map((cut, i) => (
            // eslint-disable-next-line @next/next/no-img-element -- board-link-checked cut-out
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
            <Tag tone="ink">{statusLabel}</Tag>
            {elapsed ? <span className="pn-board-meta">{elapsed}</span> : null}
          </div>
          {idea ? <p className="pn-print-idea">{`“${idea}”`}</p> : null}
          <p className="pn-develop-line">{line}</p>
          {footer}
        </div>
      </div>
    </article>
  );
}
