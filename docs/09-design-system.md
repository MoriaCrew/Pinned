# 09 — Per-game design system

> The look, words and components are now defined in
> [`docs/14-design-system.md`](14-design-system.md), which wins where
> the two disagree.

Status: **Accepted** — all five decisions settled by the owner
(decisions 1–3 on Oct 27, decisions 4–5 accepted Oct 28).

> PIN-52 seam (Oct 29): preset hosts are deleted with the game. The looks
> below survive as board themes only (src/domain/board-themes.ts, art in
> public/themes/); host identity, voice and challenge text in this
> document are historical.

## What exists

- One global palette in `globals.css` (`--ink --paper --muted
  --accent --line`), Georgia display type, system sans body.
- `Game.persona` = name, language, voiceRules, catchphrases,
  judgingStyle — generated once at creation, stored on the game.
- Gateway has `posterBackground(challenge)` via Muse Image
  (~$0.01/image, ~11s measured) — planned for the PIN-11 poster,
  not used on pages yet.
- Cut-out compositing (sharp) is proven in the SAM lab (PIN-36).
- ADR-002: no levels/settings friction. Per-game theming must
  cost the player zero decisions.

## Settled decisions

1. **Identity source = curated preset library** (Oct 27). Ship
   5–10 ready-made host + look bundles the creator just taps,
   illustrated/pre-generated with Higgsfield offline and stored
   as cached static assets (PIN-41). No per-game generation cost
   or wait; every game still looks and sounds different because
   the preset differs. Token-driven theming is the mechanism:
   each preset carries its palette/type/motif tokens.
2. **Presets first, invent-your-own as the last card** (Oct 27).
   Create opens on the preset gallery: tap a preset, tap create
   — no keyboard needed. A final "Invent your own" card opens
   the one-line brief + generated persona path.
3. **One card system, phased; collectibles later** (Oct 27).
   Now: preset cards at create (illustrated host, name,
   catchphrase, preset colors) and a player name card in-game
   (name, per-player color from the preset palette, icon
   status). The end poster (PIN-11) reuses the same system.
   Collectible entry cards are a later phase.
4. **Onboarding** (accepted Oct 28): no tutorial screens. The
   1-2-3 strip plus one contextual hint at a time on the real
   page, disappearing once done. A demo game is a landing-page
   extra, not a gate.
5. **Fresh vs cached** (accepted Oct 28): identity (preset +
   theme) is fixed for a game's life; a rematch may keep or
   re-pick the preset. Nothing re-rolls on refresh — familiar
   beats surprising mid-game.

## Related owner decisions

- Prod AI flip approved for the weekend of Oct 31–Nov 1:
  promotion `dev` → `main` with `AI_MOCK=0` and the Meta key
  referenced from Secret Manager. Dev remains the proving
  ground until that merge.
