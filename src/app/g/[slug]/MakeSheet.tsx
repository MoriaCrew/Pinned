"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { PinCard } from "../../../domain/board-view";
import { appendDictation, applyChip, chipThumbs, scenePayload } from "../../../domain/make-sheet";
import { t, tf } from "../../../i18n";
import { useLocale } from "../../../i18n/client";
import { Button, Chip, Hint, Pin, SceneCard, Sheet, Tag, TextField } from "../../../ui";
import { DictateButton } from "./DictateButton";

/**
 * Make-a-scene sheet (PIN-70, restyled on the design system in
 * PIN-100): the picked things, an idea field and idea chips (fixed
 * Policy list instantly; generated chips for these picks swap in
 * when ready, PIN-75). "Make it" hands a validated payload to the
 * board (which owns the developing print and polling) and closes
 * the sheet. In remix mode (PIN-79) the base scene sits on top as a
 * small print and the picks are the things to add.
 */
export function MakeSheet({
  cards,
  chips,
  pinsPerScene,
  promptMaxChars,
  initialPrompt,
  remixParent = null,
  dictate = null,
  onMake,
  onClose,
}: {
  cards: PinCard[];
  chips: readonly string[];
  pinsPerScene: { min: number; max: number };
  promptMaxChars: number;
  initialPrompt: string;
  /** Remix mode (PIN-79): the parent scene being extended; ratio is its print shape (PIN-129). */
  remixParent?: { id: string; imageUrl: string; prompt: string; ratio: string } | null;
  /** Dictation (PIN-119): board slug + Policy clip cap; null hides the mic. */
  dictate?: { slug: string; maxSeconds: number } | null;
  onMake: (payload: { elementIds: string[]; prompt: string; pinIds: string[]; parentSceneId?: string }) => void;
  onClose: () => void;
}) {
  const locale = useLocale();
  const [prompt, setPrompt] = useState(initialPrompt);
  // Generated chips can replace the fixed list mid-session
  // (PIN-75). Every chip ever shown stays "known" so a prompt
  // that is just an earlier fixed chip still swaps (not appends)
  // when a generated chip is tapped.
  const [knownChips, setKnownChips] = useState<readonly string[]>(chips);
  useEffect(() => {
    setKnownChips((current) => {
      const extra = chips.filter((chip) => !current.includes(chip));
      return extra.length > 0 ? [...current, ...extra] : current;
    });
  }, [chips]);

  const fieldRef = useRef<HTMLDivElement>(null);
  const thumbs = useMemo(() => chipThumbs(chips, cards), [chips, cards]);

  // Validation only — the board assigns the client sceneId per
  // attempt so a network retry can reuse it (idempotent, PIN-69).
  const valid = scenePayload(cards, prompt, "pending", pinsPerScene, promptMaxChars, remixParent?.id);

  function writeOwn() {
    setPrompt("");
    fieldRef.current?.querySelector("textarea")?.focus();
  }

  function make() {
    if (!valid) return;
    onMake({
      elementIds: valid.elementIds,
      prompt: valid.prompt,
      pinIds: cards.map((card) => card.pinId),
      ...(valid.parentSceneId ? { parentSceneId: valid.parentSceneId } : {}),
    });
  }

  return (
    <Sheet
      layer="fixed"
      className="pn-make-sheet"
      title={remixParent ? t(locale, "make.remixTitle") : t(locale, "make.title")}
      onClose={onClose}
      footer={
        <Button variant="primary" size="lg" block iconEnd="arrow" disabled={!valid} onClick={make}>
          {t(locale, "make.it")}
        </Button>
      }
    >
      {remixParent ? (
        <div className="pn-make-base" role="group" aria-label={t(locale, "make.remixBase")}>
          <SceneCard
            className="pn-make-base-print"
            src={remixParent.imageUrl}
            ratio={remixParent.ratio}
            seed={remixParent.id}
          />
          <div className="pn-make-base-text">
            <Tag tone="mark" icon="remix">
              {t(locale, "make.remixBase")}
            </Tag>
            <p>{tf(locale, "ui.quoted", { text: remixParent.prompt })}</p>
          </div>
        </div>
      ) : null}

      {cards.length > 0 ? (
        <ul className="pn-make-picks" aria-label={t(locale, "ui.pickedThings")}>
          {cards.map((card) => (
            <Pin
              key={card.pinId}
              as="li"
              src={card.element.imageUrl}
              label={card.element.label}
              owner={{ id: card.ownerId, name: card.ownerName ?? t(locale, "board.someone") }}
              seed={card.element.id}
            />
          ))}
        </ul>
      ) : (
        <Hint point="none">{t(locale, "make.pickHint")}</Hint>
      )}

      <div ref={fieldRef}>
        <TextField
          id="scene-prompt"
          label={t(locale, "make.idea")}
          value={prompt}
          onChange={setPrompt}
          placeholder={t(locale, "make.ideaPlaceholder")}
          multiline
          rows={3}
          maxLength={promptMaxChars}
        />
        {dictate ? (
          <DictateButton
            slug={dictate.slug}
            maxSeconds={dictate.maxSeconds}
            onText={(text) =>
              setPrompt((current) => appendDictation(current, text, promptMaxChars))
            }
          />
        ) : null}
      </div>

      {chips.length > 0 ? (
        <div className="pn-chip-row pn-make-chips" role="group" aria-label={t(locale, "make.ideasLabel")}>
          {chips.map((chip, index) => (
            <Chip
              key={chip}
              thumb={thumbs[index]}
              selected={prompt.trim() === chip}
              onClick={() => setPrompt((current) => applyChip(current, chip, knownChips, promptMaxChars))}
            >
              {chip}
            </Chip>
          ))}
          <Chip icon="plus" onClick={writeOwn}>
            {t(locale, "make.writeOwn")}
          </Chip>
        </div>
      ) : null}
    </Sheet>
  );
}
