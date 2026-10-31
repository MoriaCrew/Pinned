"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { t, tf } from "../../../i18n";
import { useLocale } from "../../../i18n/client";
import { IconButton, Menu } from "../../../ui";

/**
 * One My boards card (PIN-166): the server-rendered board link plus a
 * More menu whose "Remove from My boards" asks once more, then hides
 * the card at once, DELETEs it from your list only and refreshes the
 * page so the count follows. A failed remove brings the card back
 * with an error line. Escape or a tap outside closes the menu.
 */
export function MyBoardItem({
  slug,
  title,
  theme,
  children,
}: {
  slug: string;
  title: string;
  theme: string;
  children: ReactNode;
}) {
  const locale = useLocale();
  const router = useRouter();
  const [step, setStep] = useState<"closed" | "menu" | "confirm">("closed");
  const [removed, setRemoved] = useState(false);
  const [failed, setFailed] = useState(false);
  // Open toward the middle of the screen so the menu never runs off an edge.
  const [alignStart, setAlignStart] = useState(false);
  const itemRef = useRef<HTMLLIElement>(null);
  const moreRef = useRef<HTMLSpanElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const open = step !== "closed";
  const focusMore = () => moreRef.current?.querySelector("button")?.focus();

  function close(returnFocus: boolean) {
    setStep("closed");
    if (returnFocus) focusMore();
  }

  useEffect(() => {
    if (open) boxRef.current?.querySelector("button")?.focus();
  }, [open, step]);

  useEffect(() => {
    if (failed) moreRef.current?.querySelector("button")?.focus();
  }, [failed]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (boxRef.current?.contains(target) || moreRef.current?.contains(target))) return;
      close(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close(true);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
    // close only sets state and focuses: re-bind when the menu opens.
  }, [open]);

  async function remove() {
    // Focus moves to a neighbouring card before this one hides.
    const item = itemRef.current;
    (item?.nextElementSibling ?? item?.previousElementSibling)?.querySelector("a")?.focus();
    setStep("closed");
    setFailed(false);
    setRemoved(true);
    try {
      const response = await fetch(`/api/me/boards/${encodeURIComponent(slug)}`, {
        method: "DELETE",
        credentials: "same-origin",
      });
      if (!response.ok) throw new Error("remove failed");
      router.refresh();
    } catch {
      setRemoved(false);
      setFailed(true);
    }
  }

  const menuClass = alignStart ? "pn-lib-board-menu-start" : "pn-lib-board-menu";
  return (
    <li ref={itemRef} hidden={removed}>
      {children}
      {/* The button sits on the card's ground, so it takes the card's skin. */}
      <span ref={moreRef} className="pn-lib-board-more" data-theme={theme}>
        <IconButton
          icon="more"
          variant="ghost"
          size={20}
          label={tf(locale, "myBoards.boardActions", { board: title })}
          aria-expanded={open}
          aria-haspopup="menu"
          onClick={() => {
            if (open) return close(false);
            const rect = moreRef.current?.getBoundingClientRect();
            setAlignStart(rect ? rect.left + rect.width / 2 < window.innerWidth / 2 : false);
            setFailed(false);
            setStep("menu");
          }}
        />
      </span>
      {open ? (
        <div ref={boxRef}>
          {step === "confirm" ? (
            <div className={`pn-menu ${menuClass}`} role="group" aria-label={title}>
              <p className="pn-lib-board-confirm" role="status">
                {t(locale, "myBoards.removeConfirm")}
              </p>
              <button type="button" className="pn-menu-item" data-danger="" onClick={() => void remove()}>
                {t(locale, "myBoards.removeYes")}
              </button>
              <button type="button" className="pn-menu-item" onClick={() => close(true)}>
                {t(locale, "myBoards.removeKeep")}
              </button>
            </div>
          ) : (
            <Menu
              label={tf(locale, "myBoards.boardActions", { board: title })}
              className={menuClass}
              items={[{ label: t(locale, "myBoards.remove"), onSelect: () => setStep("confirm") }]}
            />
          )}
        </div>
      ) : null}
      {failed ? (
        <p className="pn-lib-board-error" role="alert">
          {t(locale, "myBoards.removeFailed")}
        </p>
      ) : null}
    </li>
  );
}
