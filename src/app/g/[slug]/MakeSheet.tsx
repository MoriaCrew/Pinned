"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { PinCard } from "../../../domain/board-view";
import {
  appendDictation,
  applyChip,
  chipInPrompt,
  chipThumb,
  ideaChips,
  promptCountVisible,
  scenePayload,
} from "../../../domain/make-sheet";
import { t, tf } from "../../../i18n";
import { useLocale } from "../../../i18n/client";
import { Chip, Composer, Icon, IconButton, Sheet, Sticker, pickedCountLabel } from "../../../ui";
import { DictationBar, useDictation } from "./Dictation";

/**
 * Make-a-scene sheet (PIN-70, design system PIN-100, chat-style
 * composer PIN-216): a compact strip of the picks (tap one to drop it,
 * "+" goes back to picking), one scrolling row of idea chips (the
 * fixed Policy list at once; chips generated for these picks join
 * after them, behind a loading chip, PIN-75), and the composer as the
 * sheet's foot with the mic inside the field. "Make it" hands a
 * validated payload to the board (which owns the developing print and
 * polling). In remix mode (PIN-79) one line names the base scene and
 * the picks are the things to add.
 */
export function MakeSheet({
  cards,
  chips,
  fixedChips,
  chipsLoading = false,
  pinsPerScene,
  promptMaxChars,
  initialPrompt,
  remixParent = null,
  dictate = null,
  onMake,
  onRemovePick,
  onAddPicks,
  onClose,
}: {
  cards: PinCard[];
  /** Chips for these picks: the fixed list, or the generated ones once they land (PIN-75). */
  chips: readonly string[];
  /** Policy sceneChips: always first in the row. */
  fixedChips: readonly string[];
  /** Generated chips for these picks are still on their way. */
  chipsLoading?: boolean;
  pinsPerScene: { min: number; max: number };
  promptMaxChars: number;
  initialPrompt: string;
  /** Remix mode (PIN-79): the parent scene being extended; ratio is its print shape (PIN-129). */
  remixParent?: { id: string; imageUrl: string; prompt: string; ratio: string } | null;
  /** Dictation (PIN-119): board slug + Policy clip cap; null hides the mic. */
  dictate?: { slug: string; maxSeconds: number } | null;
  onMake: (payload: { elementIds: string[]; prompt: string; pinIds: string[]; parentSceneId?: string }) => void;
  onRemovePick: (pinId: string) => void;
  /** Back to picking; the idea so far goes along so it is never lost. */
  onAddPicks: (prompt: string) => void;
  onClose: (prompt: string) => void;
}) {
  const locale = useLocale();
  const ideasId = useId();
  const [prompt, setPrompt] = useState(initialPrompt);
  // Every chip shown in this sheet stays "known", so a prompt that is
  // just an earlier chip still swaps (not appends) on a later tap.
  const [knownChips, setKnownChips] = useState<readonly string[]>(chips);
  useEffect(() => {
    setKnownChips((current) => {
      const extra = chips.filter((chip) => !current.includes(chip));
      return extra.length > 0 ? [...current, ...extra] : current;
    });
  }, [chips]);

  // A dropped pick's button goes away: focus moves to "+" instead of the page.
  const addRef = useRef<HTMLButtonElement>(null);
  const refocusAdd = useRef(false);
  useEffect(() => {
    if (!refocusAdd.current) return;
    refocusAdd.current = false;
    addRef.current?.focus();
  }, [cards.length]);

  const [flashKey, setFlashKey] = useState(0);
  const [heard, setHeard] = useState("");
  const dictation = useDictation({
    slug: dictate?.slug ?? "",
    maxSeconds: dictate?.maxSeconds ?? 0,
    onText: (text) => {
      setPrompt((current) => appendDictation(current, text, promptMaxChars));
      setHeard(text);
      setFlashKey((n) => n + 1);
    },
  });

  const ideas = ideaChips(fixedChips, chips);
  const recording = dictation.state === "recording";
  const busy = dictation.state !== "idle";
  // Validation only — the board assigns the client sceneId per
  // attempt so a network retry can reuse it (idempotent, PIN-69).
  const valid = scenePayload(cards, prompt, "pending", pinsPerScene, promptMaxChars, remixParent?.id);

  function make() {
    if (!valid || busy) return;
    onMake({
      elementIds: valid.elementIds,
      prompt: valid.prompt,
      pinIds: cards.map((card) => card.pinId),
      ...(valid.parentSceneId ? { parentSceneId: valid.parentSceneId } : {}),
    });
  }

  const mic =
    dictate && dictation.supported ? (
      <IconButton
        icon={recording ? "stop" : "mic"}
        variant="ghost"
        label={t(locale, recording ? "make.dictateStop" : "make.dictate")}
        aria-disabled={dictation.state === "working" ? true : undefined}
        onClick={() => {
          if (recording) {
            dictation.stop();
          } else if (!busy) {
            setHeard("");
            dictation.start();
          }
        }}
      />
    ) : null;

  const status = recording
    ? t(locale, "make.dictateListening")
    : busy
      ? t(locale, "make.dictateWorking")
      : heard
        ? tf(locale, "make.dictateAdded", { text: heard })
        : "";

  return (
    <Sheet
      layer="fixed"
      className="pn-make-sheet"
      title={remixParent ? t(locale, "make.remixTitle") : t(locale, "make.title")}
      onClose={() => onClose(prompt)}
      footer={
        <Composer
          id="scene-prompt"
          label={t(locale, "make.idea")}
          value={prompt}
          onChange={setPrompt}
          placeholder={t(locale, "make.ideaPlaceholder")}
          maxLength={promptMaxChars}
          submitLabel={t(locale, "make.it")}
          onSubmit={make}
          submitDisabled={!valid || busy}
          tool={mic}
          overlay={
            busy ? (
              <DictationBar state={dictation.state} elapsed={dictation.elapsed} maxSeconds={dictate?.maxSeconds ?? 0} />
            ) : null
          }
          error={dictation.error}
          count={promptCountVisible(prompt, promptMaxChars) ? `${[...prompt].length}/${promptMaxChars}` : null}
          status={status}
          flashKey={flashKey}
        />
      }
    >
      {remixParent ? (
        <p className="pn-make-base" title={remixParent.prompt}>
          <img className="pn-make-base-thumb" src={remixParent.imageUrl} alt="" style={{ aspectRatio: remixParent.ratio }} />
          <span className="pn-make-base-text">
            {tf(locale, "ui.remixOfTitle", { title: tf(locale, "ui.quoted", { text: remixParent.prompt }) })}
          </span>
        </p>
      ) : null}

      <div className="pn-make-picks">
        <ul className="pn-make-pick-list" aria-label={t(locale, "ui.pickedThings")}>
          {cards.map((card) => (
            <li key={card.pinId}>
              <button
                type="button"
                className="pn-make-pick"
                aria-label={tf(locale, "make.removePick", { label: card.element.label })}
                onClick={() => {
                  refocusAdd.current = true;
                  onRemovePick(card.pinId);
                }}
              >
                <Sticker src={card.element.imageUrl} seed={card.element.id} size="var(--tap)" />
                <span className="pn-make-pick-x" aria-hidden="true">
                  <Icon name="close" size={12} strokeWidth={3} />
                </span>
              </button>
            </li>
          ))}
          {cards.length < pinsPerScene.max ? (
            <li>
              <button
                ref={addRef}
                type="button"
                className="pn-make-pick pn-make-pick-add"
                aria-label={t(locale, "make.addPicks")}
                onClick={() => onAddPicks(prompt)}
              >
                <Icon name="plus" size={20} />
              </button>
            </li>
          ) : null}
        </ul>
        <p className="pn-board-meta" aria-live="polite">
          {cards.length > 0 ? pickedCountLabel(cards.length, pinsPerScene.max, locale) : t(locale, "make.pickHint")}
        </p>
      </div>

      {ideas.length > 0 ? (
        <div className="pn-make-ideas">
          <h3 className="pn-make-ideas-title" id={ideasId}>
            {t(locale, "make.ideasLabel")}
          </h3>
          <div className="pn-chip-row pn-make-chips" role="group" aria-labelledby={ideasId}>
            {ideas.map((chip) => (
              <Chip
                key={chip}
                thumb={chipThumb(chip, cards)}
                selected={chipInPrompt(prompt, chip)}
                disabled={busy}
                onClick={() => setPrompt((current) => applyChip(current, chip, knownChips, promptMaxChars))}
              >
                {chip}
              </Chip>
            ))}
            {chipsLoading ? (
              <span className="pn-chip pn-chip-loading" aria-busy="true">
                {t(locale, "make.ideasLoading")}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
    </Sheet>
  );
}
