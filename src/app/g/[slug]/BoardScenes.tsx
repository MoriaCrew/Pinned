"use client";

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { formatElapsed, type RemixSource } from "../../../domain/board-ui";
import { t } from "../../../i18n";
import { Button, Developing, SceneCard, SectionHead, cx, type Credit, type SceneKind } from "../../../ui";
import styles from "./board.module.css";

/** The developing clock ticks once a second (display only). */
const CLOCK_TICK_MS = 1000;

export type SceneSlot =
  | {
      type: "print";
      /** Frame shape, CSS aspect-ratio "w / h" (PIN-129, domain/scene-ratio). */
      ratio: string;
      id: string;
      /** Full image: the viewer and Share. */
      src: string;
      /** Phone-sized preview the strip loads (PIN-133). */
      previewSrc: string;
      alt: string;
      idea: string;
      credits: Credit[];
      kind: SceneKind;
      remixOf: RemixSource | null;
      number?: number;
      onRemix?: () => void;
      onShare: () => void;
      /** Opens the scene viewer (PIN-131) from the picture and the credits row. */
      onOpen?: () => void;
      sharing: boolean;
      footer?: ReactNode;
    }
  | {
      type: "developing";
      ratio: string;
      id: string;
      stickers: { src: string; seed?: string }[];
      idea: string;
      /** Client clock start of my attempt; null for someone else's scene. */
      startedAt: number | null;
    }
  | {
      type: "problem";
      ratio: string;
      id: string;
      idea: string;
      line: string;
      onChangeIdea?: () => void;
      onTryAgain?: () => void;
    };

export type PrintSlot = Extract<SceneSlot, { type: "print" }>;

/**
 * Scenes (PIN-98): the newest print first in a sideways strip.
 * A scene still being made shows as Developing where it will land;
 * my failed or refused attempt shows as a print-sized card with
 * one friendly line and the way out. No scenes: one quiet line.
 * Each frame takes its slot's shape; --print-ratio lets the kit
 * narrow a tall print so it and its caption fit a phone screen.
 */
export function BoardScenes({ slots, count }: { slots: SceneSlot[]; count: number }) {
  return (
    <section aria-labelledby="board-scenes">
      <SectionHead title={t("en", "board.scenes")} count={count} id="board-scenes" focusable />
      {slots.length === 0 ? (
        <p className={styles.quietLine}>{t("en", "board.scenesEmpty")}</p>
      ) : (
        <div className={styles.strip}>
          <ul className="pn-prints">
            {slots.map((slot) => (
              <li key={`${slot.type}-${slot.id}`} data-scene-id={slot.id} style={{ "--print-ratio": slot.ratio } as CSSProperties}>
                <Slot slot={slot} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function Slot({ slot }: { slot: SceneSlot }) {
  if (slot.type === "print") {
    return (
      <SceneCard
        src={slot.previewSrc}
        alt={slot.alt}
        idea={slot.idea}
        credits={slot.credits}
        kind={slot.kind}
        remixOf={slot.remixOf}
        ratio={slot.ratio}
        number={slot.number}
        seed={slot.id}
        onRemix={slot.onRemix}
        onShare={slot.onShare}
        onOpen={slot.onOpen}
        sharing={slot.sharing}
        footer={slot.footer}
      />
    );
  }
  if (slot.type === "developing") {
    return <DevelopingSlot stickers={slot.stickers} idea={slot.idea} startedAt={slot.startedAt} ratio={slot.ratio} />;
  }
  return <ProblemCard slot={slot} />;
}

function DevelopingSlot({
  stickers,
  idea,
  startedAt,
  ratio,
}: {
  stickers: { src: string; seed?: string }[];
  idea: string;
  startedAt: number | null;
  ratio: string;
}) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    if (startedAt === null) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  const elapsed = startedAt !== null && now !== null ? formatElapsed(now - startedAt) : undefined;
  return <Developing stickers={stickers} idea={idea} elapsed={elapsed} ratio={ratio} />;
}

function ProblemCard({ slot }: { slot: Extract<SceneSlot, { type: "problem" }> }) {
  return (
    <article className="pn-print-wrap" style={{ "--t": 0 } as CSSProperties} aria-label={`${t("en", "ui.scene")}: ${slot.idea}`}>
      <div className="pn-print">
        <div className={cx("pn-print-frame", styles.problem)} style={{ aspectRatio: slot.ratio }}>
          <p className={styles.problemLine} role="alert">
            {slot.line}
          </p>
        </div>
        <div className="pn-print-body">
          {slot.idea ? <p className="pn-print-idea">{`“${slot.idea}”`}</p> : null}
          {slot.onChangeIdea || slot.onTryAgain ? (
            <div className={styles.problemActions}>
              {slot.onChangeIdea ? (
                <Button size="sm" onClick={slot.onChangeIdea}>
                  {t("en", "board.changeIdea")}
                </Button>
              ) : null}
              {slot.onTryAgain ? (
                <Button size="sm" onClick={slot.onTryAgain}>
                  {t("en", "board.retry")}
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </article>
  );
}
