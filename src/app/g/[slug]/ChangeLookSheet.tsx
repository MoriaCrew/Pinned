"use client";

import { useId, useState } from "react";
import { chooseLook, type PlusState } from "../../../domain/plus-ui";
import { SKINS, type SkinId } from "../../../domain/skins";
import { t, tf } from "../../../i18n";
import { Button, Sheet, SkinPicker, skinName } from "../../../ui";
import styles from "./board.module.css";

/**
 * Change look (PIN-111, host only): every skin as a mini board in
 * its own skin, wearing the board's own pinned things. Plus looks
 * sit with the rest, locked until Plus counts (never hidden or
 * greyed out, docs/14). Choosing is a radio pick; the one button
 * says what happens: "Use Zine" saves a look everyone sees, "Try
 * Marigold" wears a locked Plus look on this phone only.
 */
export function ChangeLookSheet({
  boardSkin,
  tryOn,
  plus,
  sample,
  onPick,
  onClose,
}: {
  /** The skin the board wears for everyone. */
  boardSkin: SkinId;
  /** The Plus look the host is trying on, if any. */
  tryOn: SkinId | null;
  plus: PlusState | null | undefined;
  /** Cut-outs of the board's pinned things for the mini boards. */
  sample: string[];
  onPick: (skin: SkinId) => void;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<SkinId>(tryOn ?? boardSkin);
  const group = `look-${useId()}`;
  const choice = chooseLook(selected, { boardSkin, tryOn, plus });
  const label = tf("en", choice.kind === "tryOn" ? "look.try" : "look.use", { skin: skinName(selected) });
  return (
    <Sheet
      title={t("en", "look.title")}
      onClose={onClose}
      className={styles.lookSheet}
      footer={
        <Button
          variant="primary"
          size="lg"
          block
          disabled={choice.kind === "none"}
          onClick={() => onPick(selected)}
        >
          {label}
        </Button>
      }
    >
      <SkinPicker
        skins={SKINS.map((skin) => ({ id: skin.id, locked: skin.plus && !plus?.active }))}
        value={selected}
        onChange={setSelected}
        sample={sample}
        name={group}
        legend={t("en", "look.title")}
      />
    </Sheet>
  );
}
