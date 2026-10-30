# 14 — Pinneds design system (PIN-95)

Status: **Accepted** by Robin on Oct 29, 2026. Replaces the
first-generation Studio look (`docs/09`), which read as
AI-generated. The product flow (`docs/11` §6) is unchanged; the
look and the interaction design are rebuilt from scratch.

## The idea

Pinneds turns the real things in people's photos into die-cut
stickers that friends pin to one shared board and mix into new
scenes. **The stickers are the interface.** Everything else
(paper, ink, one accent colour) stays quiet so the things people
bring carry the colour and the personality.

Principles:

1. **Things first, chrome second.** One accent fill per view.
2. **Show the work.** AI steps are visible as craft (names pop on
   the photo, stickers lift off it, scenes develop like a print),
   never a spinner. No sparkles or "magic" to stand for AI.
3. **Credit is content.** Every scene says what is in it and whose
   it is.
4. **One thumb, one action.** Two actions in the dock; every flow
   in a bottom sheet; 44px targets, 56px for the main action.
5. **Skins change the mood, never the map.**

## Tokens pipeline

- `src/ui/tokens.json` is the single source of design values:
  colour roles per skin, shadows per skin, spacing, radius, sizes,
  tilt, font families and the self-hosted font files.
- `npm run tokens` compiles it to `src/ui/tokens.css` (checked in,
  generated header). `src/ui/tokens.test.ts` fails when the CSS is
  stale, when a font file is missing, or when any text pair in any
  skin drops below WCAG contrast (4.5:1 text, 3:1 marks).
- The root layout loads `tokens.css` and sets `data-theme="paper"`
  on `<html>`. Any element with `data-theme="<skin>"` re-declares
  every token, so skins nest (the skin picker shows several at once).

## UI kit

- `src/ui/` holds the components (`import { … } from "../ui"`):
  Icon (20 line icons), Wordmark, Button/ButtonLink, IconButton,
  Chip, Tag, Avatar/AvatarStack, TextField, Hint, Sticker, Pin,
  CreditLine, SceneCard, Developing, BoardHeader, SectionHead, Dock,
  Sheet, EmptyState, Menu, SkinPicker, TryOnBar, PlusSheet.
- `src/ui/pinneds.css` (loaded by the root layout) styles them. Each
  skin's look (display face, sticker keyline/shadow/tilt, name-tag
  style, button and print shape, ground pattern, band) is a set of
  CSS variables declared on the `[data-theme]` element itself, so a
  nested skin always wins over an outer one.
- Give a rebuilt screen its own `data-theme` + `pn-skin-root`
  wrapper: until PIN-104 removes the first-generation stylesheet,
  its `:root` variables still win on `<html>`.
- Strings go through `src/i18n` (`ui.*`, `meta.*`, `skin.*`); `tf`
  fills `{placeholders}` and `tCount` picks singular/plural.
- `/lab/ui` (same gate as `/lab/sam`) shows every component in every
  skin with synthetic samples from `public/lab/`; use it for QA and
  PR screenshots.

## Landing and library screens (PIN-104)

- Landing (`/`), My boards, My pins and the not-found page sit on the
  Paper skin (`data-theme="paper"` + `pn-skin-root`, class
  `pn-lib-page` to drop the first-generation `main` width). Their
  small bits of CSS are the `pn-landing-…` / `pn-lib-…` block in
  `pinneds.css`.
- The landing's sticker pile and "How it works" visuals use synthetic
  images from `public/landing/` (provenance in its README), not
  `public/lab/`. The secondary "See a board" button exists only when
  `DEMO_BOARD_SLUG` is set; unset shows nothing.
- My boards draws each board as a mini board in **its own skin**
  (`skinForTheme(themeId)`): the skin's ground, display face and print
  around the latest scene, with mono counts. My pins is the sticker
  library: the kit `Pin` grid with the source board's title, and a
  "Pin here" button per pin when opened with `?board=`.
- The header strip above every page (`pn-lib-header`, only when
  sign-in is on) holds `AuthControl`: a quiet "Sign in", or the
  avatar opening the kit `Menu` (My boards, My pins, Sign out).

## Skins

A board stores its skin id in `Board.themeId`
(`src/domain/skins.ts`). First-generation theme ids still load and
map onto the closest free skin (`skinForTheme`).

| Skin | For | Display face | Board Plus |
| --- | --- | --- | --- |
| `paper` (default) | anything; lets photos lead | Bricolage Grotesque | free |
| `cork` | family, home, planning | Fraunces | free |
| `fridge` | kids, recipes, routines | Fredoka | free |
| `zine` | parties, gigs, friends | Anton (capitals) | free |
| `darkroom` | moodboards, night (dark mode) | Instrument Serif italic | Plus |
| `postcard` | trips and places | Young Serif | Plus |
| `marigold` | Día de Muertos, ofrendas, fiestas (seasonal drop) | Abril Fatface | Plus |

Marigold uses magenta for actions (white text 5.5:1) and marigold
orange for dot stickers and highlights: orange fails as a button
fill on its cream ground (2.1:1).

## Type

- Reading: Atkinson Hyperlegible Next (designed for low-vision
  readers; 16px minimum for sentences).
- Tags, counts, catalogue numbers: Atkinson Hyperlegible Mono.
- Display faces only for the board title, section heads and sheet
  titles, always through the skin.
- All fonts are self-hosted from `public/fonts` (OFL 1.1, see
  `public/fonts/LICENSES.md`); the reading face and Bricolage
  Grotesque are preloaded.

## Link card (PIN-102)

A board link pasted into a chat shows a 1200 x 630 card in the
board's skin (`src/app/g/[slug]/opengraph-image.tsx`, reused by
`twitter-image.tsx`): wordmark, "{name} invited you to pin your
things to" (earliest participant; dropped when nobody joined), the
title in the skin's display face, a mono counts line, and the latest
five pinned cut-outs piled as die-cut stickers (never candidates).
No pins yet: three dashed ghost outlines.

- Layout and per-skin look: `src/domain/board-card.ts` (mirrors
  `pinneds.css`; a test fails when they drift). Colours come from
  `tokens.json`.
- next/og has no CSS filters, so `src/server/board-card.ts` bakes
  each sticker's keyline and shadow with sharp (alpha dilation, blurred
  offset alpha; Zine gets the hard black offset and no keyline, Cork a
  pushpin) and lays the pile over the rendered copy.
- next/og reads TTF only: Latin subsets of the faces live in
  `src/server/og-fonts/` (OFL, see its `LICENSES.md`), traced into the
  server bundle by `next.config.ts`. Characters outside them (emoji,
  other scripts) are left off the card so the renderer never fetches
  fonts or emoji from a CDN; an empty title falls back to the brand line.
- A bad slug, a missing board or any render error answers 200 with the
  generic Paper card, then `public/og-card.png` as a last resort.

## Decisions log

| Date | Decision | Why |
| --- | --- | --- |
| Oct 29 | Die-cut sticker identity, no emoji in UI | 2026 design trend toward hand-made craft; sets Pinneds apart from generic AI tools |
| Oct 29 | Paper is the default skin | Neutral ground lets people's photos carry the colour |
| Oct 29 | Tilted grid, 3 across on phones | Scannable and tappable one-handed; still feels hand-pinned |
| Oct 29 | All four hero moments: cut-out moment, developing scene, Spark-suggested skin, link preview card | Show the AI's work as craft |
| Oct 29 | Board Plus, host pays, guests never pay; one-time per board and monthly host plan; Stripe later | Money story without touching the free core loop |
| Oct 29 | Marigold seasonal skin (Plus) | Demo week includes Día de Muertos |
| Oct 29 | Atkinson Hyperlegible for reading | Usable by anyone from day one |
