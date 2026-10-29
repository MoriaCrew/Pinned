"use client";

import { useState } from "react";
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
  onMake,
  onClose,
}: {
  cards: PinCard[];
  chips: readonly string[];
  pinsPerScene: { min: number; max: number };
  promptMaxChars: number;
  initialPrompt: string;
  onMake: (payload: { elementIds: string[]; prompt: string; pinIds: string[] }) => void;
  onClose: () => void;
}) {
  const [prompt, setPrompt] = useState(initialPrompt);
  // Validation only — the board assigns the client sceneId per
  // attempt so a network retry can reuse it (idempotent, PIN-69).
  const valid = scenePayload(cards, prompt, "pending", pinsPerScene, promptMaxChars);

  return (
    <div className="sheet-backdrop" role="presentation" onClick={onClose}>
      <section
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={t("en", "make.title")}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="sheet-head">
          <h2>{t("en", "make.title")}</h2>
          <button type="button" className="btn btn-small" onClick={onClose}>
            {t("en", "add.close")}
          </button>
        </div>

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
                onClick={() => setPrompt((current) => applyChip(current, chip, chips, promptMaxChars))}
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
