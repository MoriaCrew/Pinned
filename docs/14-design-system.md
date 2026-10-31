# 14 — Pinneds design system (PIN-95)

Status: **Accepted** by Robin on Oct 29, 2026. Replaces the
first-generation Studio look (`docs/archive/09`), which read as
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
  Icon (23 line icons), Wordmark, Button/ButtonLink, IconButton,
  Chip, Tag, Avatar/AvatarStack, TextField, Hint, Sticker, Pin,
  CreditLine, SceneCard, Developing, BoardHeader, SectionHead,
  FilterChips, Dock, Sheet, EmptyState, Menu, SkinPicker, TryOnBar,
  PlusSheet, Composer.
- `FilterChips` (PIN-218) is the board's pin filter row under the
  Pins head: New (pins from others since your last visit) · All ·
  Mine · one chip per person with pins, most recently active first.
  It sticks to the top while the grid scrolls, scrolls sideways,
  and each chip is a 44px `aria-pressed` toggle with its count; a
  person chip is their colour dot and their name cut at 14ch (the
  full name is spoken). The row is left out when no chip would
  narrow the grid; one person's pins hide the owner line. It only
  filters the grid: picks, the tray and pruning use every pin. The
  choice lasts for the tab (sessionStorage); "last visit" is the
  newest pin time seen, saved to localStorage when the page is
  hidden or left (`src/domain/pin-filter.ts`,
  `src/app/g/[slug]/usePinFilter.ts`).
- `Composer` (PIN-216) is the Make sheet's foot, shaped like a chat
  box: a field that grows from one line to four (then scrolls), the
  mic inside it on the right, and the labelled "Make it" beside it
  (Enter sends, Shift+Enter is a new line, never during IME
  composition). Recording draws over the field (dot, elapsed / the
  Policy clip cap) without resizing it, and the mic turns into Stop
  in place. The count shows only near `scenePromptMaxChars`. Above
  it: the picks as 40px stickers (tap one to drop it, "+" back to
  picking) and the ideas as one sideways-scrolling chip row; chips
  generated for the picks join after the fixed ones, behind a
  "Finding more ideas" chip, and a chip wears a sticker only when it
  names that pick.
- `src/ui/pinneds.css` (loaded by the root layout) styles them. Each
  skin's look (display face, sticker keyline/shadow/tilt, name-tag
  style, button and print shape, ground pattern, band) is a set of
  CSS variables declared on the `[data-theme]` element itself, so a
  nested skin always wins over an outer one.
- A scene print (`SceneCard`) keeps the picture clear: the frame holds
  the image and nothing else (PIN-128). The Remix / Collage tag
  (left) and the scene number "Nº 02" (right) are one small row on
  the paper (`.pn-print-meta`) between the picture and the idea, in
  every skin; the row is left out when a print has neither.
  `Developing` keeps its own status tag in its body.
- The frame takes the scene's own shape (PIN-129): its stored pixel
  size (`Scene.width`/`height`, read with sharp), else the shape of
  `Policy.sceneSize` (`domain/scene-ratio`); the picture still covers
  the frame, never with bars. Developing and problem cards use the
  Policy shape so nothing jumps when the print lands. In `.pn-prints`
  an item that sets `--print-ratio` narrows so its picture stays
  within `--print-frame-max` tall (a tall print and its caption fit a
  390x844 screen above the dock).
- `CreditLine` has two forms. The full list (a pill per thing with
  its maker) is for the scene viewer. `compact` (PIN-130) is what a
  print carries: "Made from" over one row of overlapping `--avatar-lg`
  stickers with a "+N" disc when the row is full, then the "Remix of"
  line, so a print is the same height for 2 things or 9. The row is
  not a control: it is one image whose accessible name lists every
  thing ("Made from teal mug, rubber duck and succulent"); `onOpen`
  makes it one button, 44px or taller. How many stickers fit
  (`COMPACT_CREDIT_SLOTS`) is layout, not Policy.
- `SceneCard` `onOpen` (PIN-131) wraps the frame in a bare button
  named by the idea (`.pn-print-open`, no box of its own, so nothing
  shifts) and passes `onOpen` to the compact credits row; both say
  `aria-haspopup="dialog"`. The board's scene viewer shows the whole
  picture contained on `--viewer-bg` (the skin's dark ground), then
  the full `CreditLine` on a sheet panel with Share first. Its More
  menu (PIN-143) holds Delete for the scene's maker or the host: the
  confirm (Delete / Keep) takes the actions row's place in the
  panel, so the idea and Close stay in view, and holds the error
  line; Esc closes the menu or confirm before the viewer.
  A remix of a deleted scene says "Remix of a deleted scene".
- Give a screen its own `data-theme` + `pn-skin-root` wrapper: it
  paints the ground, ink and reading face, and lets a board wear a
  different skin than `<html>`. `src/app/globals.css` is only a reset
  (box-sizing, body margin and default-skin ground, reduced motion);
  never add classes or tokens there. Screen-local layout goes in a
  CSS module next to the screen, built from tokens.
- Strings go through `src/i18n` (`ui.*`, `meta.*`, `skin.*`); `tf`
  fills `{placeholders}` and `tCount` picks singular/plural.
- `/lab/ui` (same gate as `/lab/sam`) shows every component in every
  skin with synthetic samples from `public/lab/`; use it for QA and
  PR screenshots.

## Landing and library screens (PIN-104)

- Landing (`/`), My boards, My pins and the not-found page sit on the
  Paper skin (`data-theme="paper"` + `pn-skin-root`, class
  `pn-lib-page` for the full-height page shell). Their
  small bits of CSS are the `pn-landing-…` / `pn-lib-…` block in
  `pinneds.css`.
- The landing's sticker pile and "How it works" visuals use synthetic
  images from `public/landing/sets/<id>/` (provenance in
  `public/landing/README.md`), not `public/lab/`. The secondary "See a
  board" button exists only when `DEMO_BOARD_SLUG` is set; unset shows
  nothing.
- **Showcase sets (PIN-175).** The pile, the step-1 photo with its two
  name tags, the three step-2 stickers and the step-3 scene all come
  from one set, picked per request (the page is dynamic, so a
  returning visitor sees a different one). A set is plain data in
  `src/app/landing-sets.data.ts` (type and picking in the pure
  `src/domain/landing-sets.ts`): sticker id to file and owner (a
  made-up first name), 5 to 7 pile slots, the photo's crop and tag
  anchors, the trio, the scene's crop. Every position is a percentage
  of the box it sits in; a tag's anchor is its **centre** in percent of
  the step-1 art box (so it can later follow a real segmentation box)
  with a tilt in degrees. `?set=<id>` pins a set (an unknown or
  repeated value is a random pick), and the quiet "Show another" link
  under the pile is a plain `<a href="/?set=<other id>">`: no script,
  no cookie, 44px tall, with an accessible name that says what it
  changes because the pictures themselves are hidden from assistive
  tech. `src/app/landing-sets.test.ts` is the manifest: every file
  exists and is used, 5 to 7 distinct pile stickers, a trio from at
  least two friends, tag text in the catalog and at most 13 characters
  (the art box is 124 px wide on a phone), no EXIF, no XMP but the
  IPTC "made by a trained model" marker, at most 220 KB per set. To
  add a set: a folder under `public/landing/sets/`, a provenance row
  in its README, one entry in the data file; the whole recipe, from
  source photos to screenshots, is `docs/17-showcase-sets.md`. Layout
  notes from the try-on and cat sets: a sticker's `size` is the side
  of a square box and the picture fits inside it, so a tall cut-out (a
  standing person, a skateboard) needs a size near 50 to read; the
  foil sweep recolours whatever it crosses, so put it on a sticker
  whose colour the scene does not depend on.
- My boards draws each board as a mini board in **its own skin**
  (`skinForTheme(themeId)`): the skin's ground, display face and print
  around the latest scene, with mono counts. My pins is the sticker
  library: the kit `Pin` grid with the source board's title, and a
  "Pin here" button per pin when opened with `?board=`.
- No bar above the pages (PIN-120). Each page's own top row ends
  with the one "you" button (`src/app/auth/You.tsx`, decisions in
  `src/domain/you-menu.ts`): the Google photo, else your initials in
  your person colour once you joined the board, else a person icon.
  It opens the kit `Menu`, each entry only when it applies: "You're
  {name} here" (a quiet `note` line) + Edit name, or Join this board;
  My boards + My pins when signed in; Board Plus with the creations
  left as a quiet `detail` subline, for everyone on a board with
  creations (PIN-183); Change look for the host, or a member once the
  board has Plus (PIN-183); a danger Delete board (asks first,
  PIN-168) for the host; Sign in with
  Google / Sign out when sign-in is on. Off a board it is
  account-only: nothing in link-only, a quiet "Sign in" when signed
  out (left out where the page itself asks you to sign in), the
  avatar menu once signed in. On the landing it sits top right over
  the hero.
- Board header: wordmark · Share · you. Who else is here moves to
  the start of the meta line as a small `AvatarStack` (`size="sm"`,
  `--avatar-sm`); you are not in it, you are the button.

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
  generic Paper card, then `public/og-card.png` as a last resort. That
  PNG (and its copy in `src/server/og-assets/`) is the generic card
  itself: regenerate both with `npm run og:card` after changing the
  card design or the `card.fallback*` copy (PIN-203).

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
| Oct 30 | First-generation `globals.css` removed (PIN-114); only a reset remains | Its `:root` tokens and bare `main`/`h1`/`footer` rules fought the skins; `/lab/sam` keeps its styles in a CSS module |
| Oct 30 | The Things grid shows pinned things only; a photo's unpinned candidates get one line above it (Pin them reopens that photo's review, Clear asks once) (PIN-122) | "Not pinned yet" stickers in the grid read as things from other boards |
| Oct 30 | A thing's name tag wraps to up to 3 lines, "…" only past that (PIN-164) | One line cut most names after ~9 letters in the wide uppercase looks |
| Oct 31 | One purchase replaces the Plus plans and makes packs: €2.99 once per board for Plus + 20 creations, bought by any joined member for the board; free pool 5; members change the look once the board has Plus; no host plan sold (PIN-181; supersedes the Oct 29 Plus row) | One clear thing to buy; guests never have to pay, and anyone who wants more can give it to the board |
| Oct 31 | One Board Plus sheet is the only screen that asks for money: the perks plus one €2.99 purchase (Plus + 20 creations) for the board, through the credits checkout; no plan cards, no Host plan, no separate "Add makes" sheet; makes are called "creations" in the UI (PIN-182) | One clear thing to buy and one word for what it buys; any member can give it to the board, and nobody sees a price list |
| Oct 31 | The Make sheet is a chat-style composer: mic and Stop are icon buttons inside the field (the chat convention, an exception to "icon-only for close, share, more"), "Make it" stays labelled; ideas are one scrolling row; tapping a pressed chip takes it back out (PIN-216) | Robin: the mic below the field felt awkward; the old sheet overflowed a 390x844 phone and wiped typed text |
| Oct 31 | The creations indicator speaks only at `lowMakesWarning` or fewer left, as one quiet board-meta line with a text button (no card, nothing above the threshold); running out is an invitation into the Plus sheet, never an error; the count lives in the you menu as Board Plus; any joined member can change the look once Plus is on (PIN-183) | A board with plenty looks like a credits-off board; money is offered when it helps, not shown all the time |
| Oct 31 | Busy boards get a sticky filter row above the pins (New / All / Mine / people) instead of reordering or paging the grid; the grid stays oldest first (PIN-218) | 100+ pins from 18 people is 40 rows; finding your own or a friend's pins, or what is new, should take one tap, and polling must never reshuffle the grid |
| Oct 31 | When a page throws, visitors get the Paper dead end "Something came unpinned." with Try again and Go home, never the error, its message or digest; `global-error` carries the same screen when the root layout itself fails (PIN-212) | Judges and first-time visitors never see Next's bare "Application error"; same quiet look as not-found, one primary action |
