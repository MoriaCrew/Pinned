import type { CSSProperties, ReactNode } from "react";
import type { MyBoardCard } from "../../domain/my-boards";
import type { MyPinCard } from "../../domain/my-pins";
import { skinForTheme } from "../../domain/skins";
import { t } from "../../i18n";
import { Pin, Wordmark } from "../../ui";
import { You } from "../auth/You";
import { PinToBoardButton } from "./pins/PinToBoardButton";
import { boardCardMeta } from "./library-format";

/**
 * Top of My boards / My pins: wordmark, optional action and the
 * "you" button (PIN-120), the page name, a mono count.
 */
export function LibraryHeader({
  title,
  meta,
  action,
  offerSignIn = true,
}: {
  title: string;
  meta?: string;
  action?: ReactNode;
  /** False when the page itself is the sign-in prompt (no second "Sign in" up top). */
  offerSignIn?: boolean;
}) {
  return (
    <header className="pn-head">
      <div className="pn-head-row">
        <Wordmark size={22} href="/" />
        <div className="pn-head-right">
          {action}
          <You offerSignIn={offerSignIn} />
        </div>
      </div>
      <h1 className="pn-board-title">{title}</h1>
      {meta ? <p className="pn-board-meta">{meta}</p> : null}
    </header>
  );
}

/** A quiet "nothing here yet" or "sign in first": ghost outlines, one line, one action. */
export function LibraryEmpty({
  title,
  body,
  headingLevel = 2,
  children,
}: {
  title: string;
  body?: string;
  /** 1 when the state is the whole page (not found), 2 under a page title. */
  headingLevel?: 1 | 2;
  children?: ReactNode;
}) {
  const Heading = headingLevel === 1 ? "h1" : "h2";
  return (
    <section className="pn-empty pn-lib-empty">
      <div className="pn-empty-ghosts" aria-hidden="true">
        <span className="pn-ghost" style={{ "--t": -0.8 } as CSSProperties} />
        <span className="pn-ghost pn-ghost-tall" style={{ "--t": 0.6 } as CSSProperties} />
        <span className="pn-ghost pn-ghost-wide" style={{ "--t": -0.3 } as CSSProperties} />
      </div>
      <Heading className="pn-section-title">{title}</Heading>
      {body ? <p className="pn-empty-body">{body}</p> : null}
      {children ? <div className="pn-empty-actions">{children}</div> : null}
    </section>
  );
}

/**
 * Each board as a mini board in its own skin (like the SkinPicker's):
 * the ground, the title in the skin's display face, the latest scene
 * as a small print, then your count and the last active day in mono.
 */
export function BoardCards({ boards }: { boards: MyBoardCard[] }) {
  return (
    <ul className="pn-lib-boards">
      {boards.map((board) => (
        <li key={board.slug}>
          <a className="pn-lib-board" data-theme={skinForTheme(board.themeId)} href={`/g/${board.slug}`}>
            <span className="pn-skin-band" aria-hidden="true" />
            <span className="pn-lib-board-title">{board.title}</span>
            {board.latestSceneImageUrl ? (
              <span className="pn-lib-board-print" aria-hidden="true">
                {/* eslint-disable-next-line @next/next/no-img-element -- board-link-checked image route */}
                <img src={board.latestSceneImageUrl} alt="" loading="lazy" />
              </span>
            ) : (
              <span className="pn-lib-board-ghosts" aria-hidden="true">
                <span className="pn-ghost" style={{ "--t": -0.8 } as CSSProperties} />
                <span className="pn-ghost pn-ghost-tall" style={{ "--t": 0.6 } as CSSProperties} />
                <span className="pn-ghost pn-ghost-wide" style={{ "--t": -0.3 } as CSSProperties} />
              </span>
            )}
            <BoardCardMeta myPinCount={board.myPinCount} lastActivityAt={board.lastActivityAt} />
          </a>
        </li>
      ))}
    </ul>
  );
}

function BoardCardMeta({ myPinCount, lastActivityAt }: { myPinCount: number; lastActivityAt: number }) {
  const meta = boardCardMeta(myPinCount, lastActivityAt);
  return (
    <span className="pn-lib-board-meta">
      <span>{meta.mine}</span>
      <span>{meta.last}</span>
    </span>
  );
}

/**
 * The sticker library: your cut-outs as pins, each with the board it
 * came from. With a board context (?board=) every pin also gets a
 * "Pin here" button.
 */
export function PinLibrary({ cards, boardSlug }: { cards: MyPinCard[]; boardSlug: string | null }) {
  return (
    <ul className="pn-pins pn-lib-pins" data-pinnable={boardSlug ? "" : undefined}>
      {cards.map((card) => (
        <Pin key={card.elementId} as="li" src={card.imageUrl} label={card.label} seed={card.elementId}>
          <span className="pn-lib-from">
            {t("en", "myPins.fromBoard")} {card.sourceBoardTitle}
          </span>
          {boardSlug ? <PinToBoardButton slug={boardSlug} elementId={card.elementId} label={card.label} /> : null}
        </Pin>
      ))}
    </ul>
  );
}
