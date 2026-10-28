import { playerColorFor } from "../../../domain/board-themes";
import { t } from "../../../i18n";
import type { JoinPlayerView } from "./JoinPanel";

/**
 * Player name card (PIN-40): one card system with theme cards.
 * Avatar initial in the player's stable color, name, icon status,
 * poster consent in words (never icon-only).
 */
export function PlayerCard({
  player,
  photoDone,
  onEdit,
}: {
  player: JoinPlayerView;
  photoDone: boolean;
  onEdit?: () => void;
}) {
  const initial = ([...player.displayName][0] ?? "?").toUpperCase();
  return (
    <section className="card" aria-live="polite">
      <div className="player-card">
        <span
          className="player-avatar"
          style={{ background: playerColorFor(player.id) }}
          aria-hidden="true"
        >
          {initial}
        </span>
        <div className="who">
          <strong>{player.displayName}</strong>
          <p className="fact-chips">
            <span className="fact-chip">
              {photoDone ? t("en", "card.photoIn") : t("en", "card.noPhoto")}
            </span>
            <span className="fact-chip">
              {player.posterOptIn ? t("en", "card.posterYes") : t("en", "card.posterNo")}
            </span>
            {onEdit ? (
              <button type="button" className="btn btn-small" onClick={onEdit}>
                {t("en", "join.edit")}
              </button>
            ) : null}
          </p>
        </div>
      </div>
    </section>
  );
}
