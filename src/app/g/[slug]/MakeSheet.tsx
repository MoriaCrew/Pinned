"use client";

import { useEffect, useState } from "react";
import type { PinCard } from "../../../domain/board-view";
import { applyChip, scenePayload } from "../../../domain/make-sheet";
import { playerColorFor } from "../../../domain/board-themes";
import { t } from "../../../i18n";

/**
 * Make-a-scene sheet (PIN-70, docs/11 section 6): the picked pins,
 * a prompt box and suggestion chips (fixed Policy list instantly;
 * generated chips for these picks swap in when ready, PIN-75). "Make it ✨"
 * hands a validated payload to the board (which owns the cooking
 * card and polling) and closes the sheet.
 */
export function MakeSheet({
  cards,
  chips,
  pinsPerScene,
  promptMaxChars,
  initialPrompt,
  remixParent = null,
  onMake,
  onClose,
}: {
  cards: PinCard[];
  chips: readonly string[];
  pinsPerScene: { min: number; max: number };
  promptMaxChars: number;
  initialPrompt: string;
  /** Remix mode (PIN-79): the parent scene being extended. */
  remixParent?: { id: string; imageUrl: string; prompt: string } | null;
  onMake: (payload: { elementIds: string[]; prompt: string; pinIds: string[]; parentSceneId?: string }) => void;
  onClose: () => void;
}) {
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
  // Validation only — the board assigns the client sceneId per
  // attempt so a network retry can reuse it (idempotent, PIN-69).
  const valid = scenePayload(cards, prompt, "pending", pinsPerScene, promptMaxChars, remixParent?.id);

  return (
    <div className="sheet-backdrop" role="presentation" onClick={onClose}>
      <section
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={remixParent ? t("en", "make.remixTitle") : t("en", "make.title")}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="sheet-head">
          <h2>{remixParent ? t("en", "make.remixTitle") : t("en", "make.title")}</h2>
          <button type="button" className="btn btn-small" onClick={onClose}>
            {t("en", "add.close")}
          </button>
        </div>

        {remixParent ? (
          <ul className="thumb-row">
            <li className="thumb-item">
              {/* eslint-disable-next-line @next/next/no-img-element -- board-link-checked API image */}
              <img src={remixParent.imageUrl} alt={remixParent.prompt} loading="lazy" />
              <span className="thumb-owner">{t("en", "make.remixBase")}</span>
            </li>
          </ul>
        ) : null}

        {cards.length > 0 ? (
          <ul className="thumb-row">
            {cards.map((card) => (
              <li key={card.pinId} className="thumb-item">
                {/* eslint-disable-next-line @next/next/no-img-element -- board-link-checked API image */}
                <img src={card.element.imageUrl} alt={card.element.label} loading="lazy" />
                <span className="thumb-owner">
                  <span
                    className="chip-dot"
                    style={{ background: playerColorFor(card.ownerId) }}
                    aria-hidden="true"
                  />{" "}
                  {card.ownerName ?? t("en", "board.someone")}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="hint" role="status">{t("en", "make.pickHint")}</p>
        )}

        <div className="field">
          <label htmlFor="scene-prompt">{t("en", "make.idea")}</label>
          <textarea
            id="scene-prompt"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder={t("en", "make.ideaPlaceholder")}
            rows={3}
            maxLength={promptMaxChars}
          />
        </div>

        {chips.length > 0 ? (
          <div className="chip-row" role="group" aria-label={t("en", "make.idea")}>
            {chips.map((chip) => (
              <button
                key={chip}
                type="button"
                className="chip-btn"
                aria-pressed={prompt.trim() === chip}
                onClick={() => setPrompt((current) => applyChip(current, chip, knownChips, promptMaxChars))}
              >
                {chip}
              </button>
            ))}
          </div>
        ) : null}

        <div className="sheet-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={!valid}
            onClick={() =>
              valid &&
              onMake({
                elementIds: valid.elementIds,
                prompt: valid.prompt,
                pinIds: cards.map((card) => card.pinId),
                ...(valid.parentSceneId ? { parentSceneId: valid.parentSceneId } : {}),
              })
            }
          >
            {t("en", "make.it")}
          </button>
        </div>
      </section>
    </div>
  );
}
