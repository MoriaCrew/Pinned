"use client";

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { formatElapsed } from "../../../domain/board-ui";
import { t } from "../../../i18n";
import { Button, Developing, SceneCard, SectionHead, cx, type Credit, type SceneKind } from "../../../ui";
import styles from "./board.module.css";

/** Prints in the strip share one frame shape (design system Board). */
const PRINT_RATIO = "4 / 3";
/** The developing clock ticks once a second (display only). */
const CLOCK_TICK_MS = 1000;

export type SceneSlot =
  | {
      type: "print";
      id: string;
      src: string;
      alt: string;
      idea: string;
      credits: Credit[];
      kind: SceneKind;
      remixOf: { title: string; owner?: string } | null;
      number?: number;
      onRemix?: () => void;
      onShare: () => void;
      sharing: boolean;
      footer?: ReactNode;
    }
  | {
      type: "developing";
      id: string;
      stickers: { src: string; seed?: string }[];
      idea: string;
      /** Client clock start of my attempt; null for someone else's scene. */
      startedAt: number | null;
    }
  | {
      type: "problem";
      id: string;
      idea: string;
      line: string;
      onChangeIdea?: () => void;
      onTryAgain?: () => void;
    };

/**
 * Scenes (PIN-98): the newest print first in a sideways strip.
 * A scene still being made shows as Developing where it will land;
 * my failed or refused attempt shows as a print-sized card with
 * one friendly line and the way out. No scenes: one quiet line.
 */
export function BoardScenes({ slots, count }: { slots: SceneSlot[]; count: number }) {
  return (
    <section aria-labelledby="board-scenes">
      <SectionHead title={t("en", "board.scenes")} count={count} id="board-scenes" />
      {slots.length === 0 ? (
        <p className={styles.quietLine}>{t("en", "board.scenesEmpty")}</p>
      ) : (
        <div className={styles.strip}>
          <ul className="pn-prints">
            {slots.map((slot) => (
              <li key={`${slot.type}-${slot.id}`}>
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
        src={slot.src}
        alt={slot.alt}
        idea={slot.idea}
        credits={slot.credits}
        kind={slot.kind}
        remixOf={slot.remixOf}
        ratio={PRINT_RATIO}
        number={slot.number}
        seed={slot.id}
        onRemix={slot.onRemix}
        onShare={slot.onShare}
        sharing={slot.sharing}
        footer={slot.footer}
      />
    );
  }
  if (slot.type === "developing") {
    return <DevelopingSlot stickers={slot.stickers} idea={slot.idea} startedAt={slot.startedAt} />;
  }
  return <ProblemCard slot={slot} />;
}

function DevelopingSlot({
  stickers,
  idea,
  startedAt,
}: {
  stickers: { src: string; seed?: string }[];
  idea: string;
  startedAt: number | null;
}) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    if (startedAt === null) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  const elapsed = startedAt !== null && now !== null ? formatElapsed(now - startedAt) : undefined;
  return <Developing stickers={stickers} idea={idea} elapsed={elapsed} ratio={PRINT_RATIO} />;
}

function ProblemCard({ slot }: { slot: Extract<SceneSlot, { type: "problem" }> }) {
  return (
    <article className="pn-print-wrap" style={{ "--t": 0 } as CSSProperties} aria-label={`${t("en", "ui.scene")}: ${slot.idea}`}>
      <div className="pn-print">
        <div className={cx("pn-print-frame", styles.problem)} style={{ aspectRatio: PRINT_RATIO }}>
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
