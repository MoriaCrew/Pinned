"use client";

import { useEffect, useRef, useState } from "react";
import { t } from "../../../i18n";
import { IconButton, Menu } from "../../../ui";
import styles from "./board.module.css";

function focusMore(box: HTMLElement | null) {
  box?.querySelector<HTMLButtonElement>(":scope > button")?.focus();
}

/**
 * The host's More beside Share (PIN-111): board options, today just
 * "Change look". Only rendered for the board's host, which the page
 * learns on its first poll (the server-rendered view says not host).
 */
export function BoardMore({ onChangeLook }: { onChangeLook: () => void }) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    boxRef.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    const onPointer = (event: PointerEvent) => {
      if (boxRef.current?.contains(event.target as Node | null)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      focusMore(boxRef.current);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <span ref={boxRef} className={styles.boardMore}>
      <IconButton
        icon="more"
        label={t("en", "look.menu")}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((current) => !current)}
      />
      {open ? (
        <Menu
          label={t("en", "look.menu")}
          className={styles.boardMenu}
          items={[
            {
              label: t("en", "look.open"),
              onSelect: () => {
                // Focus goes back to More first, so the sheet hands it back there on close.
                focusMore(boxRef.current);
                setOpen(false);
                onChangeLook();
              },
            },
          ]}
        />
      ) : null}
    </span>
  );
}
