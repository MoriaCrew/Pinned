# 09 — Per-game design system (Draft, decision interview open)

Status: **Draft** — decisions land here as they settle. Nothing in
this doc authorizes implementation until marked Final.

## What already exists (researched, not open)

- One global palette in `globals.css` (`--ink --paper --muted
  --accent --line`), Georgia display type, system sans body.
- `Game.persona` = name, language, voiceRules, catchphrases,
  judgingStyle — generated once at creation, stored on the game.
- Gateway has `posterBackground(challenge)` via Muse Image
  (~$0.01/image, ~11s measured) — planned for the PIN-11 poster,
  not yet used on pages.
- Cut-out compositing (sharp) is proven in the SAM lab (PIN-36).
- ADR-002: no levels/settings friction. Any per-game theming must
  cost the player zero decisions.

## Open decisions

1. **Identity source** — how each game gets its fresh look:
   generated theme tokens on the game record vs a generated
   background image per game vs tokens + image only at poster.
2. **Narrative/game card** — what the shareable "card" is: the
   invite, the live scoreboard header, or the POSTER at the end;
   what is on it (host, challenge, players, cut-outs?).
3. **Token display** — where dynamic tokens become visible
   personality: player name cards? per-player color/avatar?
4. **Onboarding** — 3-tap guided first run (coach marks on the
   real page) vs a 60-second demo game vs no onboarding beyond
   the 1-2-3 step strip.
5. **Fresh vs cached** — identity fixed per game, evolving per
   rematch chain, or re-rolled each rematch?

## Settled

1. **Identity source = curated preset library** (owner decision,
   Oct 27). Ship 5–10 ready-made host + look bundles the creator
   just taps — illustrated/pre-generated with Higgsfield offline,
   stored as cached static assets. No per-game generation cost or
   wait; every game still looks and sounds different because the
   preset differs. Creating a game should take the minimum
   possible taps with zero required typing. Token-driven theming
   remains the mechanism (each preset carries its palette/type/
   motif tokens); generated imagery is baked into presets, not
   generated live at creation.
2. **Presets first, invent-your-own as the last card** (owner
   decision, Oct 27). Create opens on the preset gallery: tap a
   preset, tap create — no keyboard needed. A final "✨ Invent
   your own" card opens today's one-line brief → generated
   persona path, unchanged. The zero-input path is the default;
   invention stays one tap away.
3. **One card system, phased; collectibles later** (owner
   decision, Oct 27). Now: preset cards at create (illustrated
   host, name, catchphrase, preset colors) and a player name card
   in-game (name, per-player color from the preset palette,
   cut-out thumbnail, icon status). The end poster (PIN-11)
   reuses the same system. Collectible entry cards are planned
   as a later phase, not now.

## Proposed defaults (not owner-settled; revisit any time)

4. **Onboarding:** no tutorial screens. The 1-2-3 strip plus one
   contextual hint at a time on the real page ("👆 Start here")
   that disappears once done. A demo game is a landing-page extra,
   not a gate.
5. **Fresh vs cached:** identity (preset + theme) is fixed for a
   game's life; a rematch may keep or re-pick the preset. Nothing
   re-rolls on refresh — familiar beats surprising mid-game.
