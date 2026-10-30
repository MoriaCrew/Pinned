/**
 * Skin suggestion from a board's title (PIN-101, design system "Spark
 * suggests a look"). Pure, instant, free and deterministic: no model
 * call, no network, no clock. English and French, case- and
 * accent-insensitive. The suggestion is only ever a pre-selection in
 * the start flow's look picker; a board's skin never changes without
 * a tap.
 *
 * How it matches
 * - The title is folded (lower case, accents removed, anything that
 *   is not a letter or digit becomes one space), so "Fête d'été",
 *   "FETE D ETE" and "fete d'ete" read the same.
 * - A term matches whole words only ("party" does not match
 *   "partyless", "rome" does not match "chrome"). A term also matches
 *   its plain plural ("kid" matches "kids", "recipe" matches
 *   "recipes"); irregular plurals are listed ("parties").
 * - Multi-word terms ("road trip", "new york") match the words in
 *   that order, separated by anything that is not a letter or digit
 *   ("week-end", "week end").
 *
 * Which rule wins
 * - Rules are checked top to bottom and the first rule with a match
 *   wins, from most specific to most generic: the seasonal skin,
 *   then parties, trips, explicit mood words, home and family, kids
 *   and food, mood by time of day, and last the weak "30th"-style
 *   ordinal. So "Mamie's birthday" is a party, "School trip" is a
 *   trip, "Kitchen inspo" is a mood board and "Sunday pancakes" is
 *   the fridge.
 * - No match: Paper, with no reason (the UI then says nothing was
 *   suggested rather than inventing a reason).
 *
 * Reasons are keys; the UI shows `create.reason.<key>`.
 */
import { DEFAULT_SKIN, isPlusSkinId, type SkinId } from "./skins";

export type ReasonKey = "muertos" | "season" | "party" | "trip" | "mood" | "home" | "kids";

export interface SkinSuggestion {
  skin: SkinId;
  /** Why this skin; null when nothing matched and Paper is just the default. */
  reason: ReasonKey | null;
}

export interface SkinRule {
  skin: SkinId;
  reason: ReasonKey;
  /** Folded words or phrases (lower case a-z, 0-9 and single spaces). */
  terms: readonly string[];
  /** Extra patterns tested against the folded title. */
  patterns?: readonly RegExp[];
}

/** Lower case, no accents, every run of non-alphanumerics becomes one space. */
export function foldTitle(input: string): string {
  return input
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/œ/g, "oe")
    .replace(/æ/g, "ae")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Most specific first: the first rule with a match wins. */
export const SKIN_RULES: readonly SkinRule[] = [
  {
    // Seasonal Plus skin. "muertos" covers Día de Muertos and Día
    // de los Muertos; the demo boards are ofrendas.
    skin: "marigold",
    reason: "muertos",
    terms: [
      "muertos",
      "day of the dead",
      "ofrenda",
      "calavera",
      "catrina",
      "cempasuchil",
      "cempazuchitl",
      "marigold",
    ],
  },
  {
    skin: "marigold",
    reason: "season",
    terms: ["halloween", "toussaint", "all saints"],
  },
  {
    skin: "zine",
    reason: "party",
    terms: [
      "party",
      "parties",
      "birthday",
      "bday",
      "b day",
      "anniversary",
      "anniversaries",
      "wedding",
      "baby shower",
      "celebration",
      "gig",
      "concert",
      "night out",
      "game night",
      // French
      "anniversaire",
      "fete",
      "soiree",
      "mariage",
      "noces",
      "evg",
      "evjf",
    ],
  },
  {
    skin: "postcard",
    reason: "trip",
    terms: [
      "trip",
      "travel",
      "travelling",
      "traveling",
      "holiday",
      "vacation",
      "road trip",
      "roadtrip",
      "getaway",
      "weekend",
      "week end",
      "city break",
      "honeymoon",
      "itinerary",
      // French
      "voyage",
      "vacances",
      "escapade",
      "itineraire",
      "lune de miel",
      // Places people make boards about (EN / FR spellings).
      "paris",
      "lisbon",
      "lisbonne",
      "rome",
      "tokyo",
      "new york",
      "nyc",
      "london",
      "londres",
      "barcelona",
      "barcelone",
      "berlin",
      "amsterdam",
      "madrid",
      "venice",
      "venise",
      "istanbul",
      "marrakech",
      "japan",
      "japon",
      "italy",
      "italie",
      "spain",
      "espagne",
      "portugal",
      "greece",
      "grece",
      "mexico",
      "mexique",
    ],
  },
  {
    // Explicit mood words beat the home and kids topics: a kitchen
    // mood board is a mood board.
    skin: "darkroom",
    reason: "mood",
    terms: [
      "mood",
      "moodboard",
      "mood board",
      "inspo",
      "inspiration",
      "aesthetic",
      "vibe",
      "ambiance",
      "ambience",
    ],
  },
  {
    skin: "cork",
    reason: "home",
    terms: [
      "grandma",
      "grandpa",
      "granny",
      "grandmother",
      "grandfather",
      "grandparent",
      "family",
      "home",
      "house",
      "kitchen",
      "recipe",
      "cookbook",
      // French
      "mamie",
      "mamy",
      "papi",
      "papy",
      "grand mere",
      "grand pere",
      "grands parents",
      "grand parent",
      "famille",
      "maison",
      "cuisine",
      "recette",
    ],
  },
  {
    skin: "fridge",
    reason: "kids",
    terms: [
      "kid",
      "child",
      "children",
      "school",
      "breakfast",
      "pancake",
      "lunch",
      "snack",
      "fridge",
      // French
      "enfant",
      "ecole",
      "gouter",
      "petit dej",
      "dejeuner",
      "cantine",
    ],
  },
  {
    // Time-of-day words are weak: they lose to every topic above.
    skin: "darkroom",
    reason: "mood",
    terms: ["night", "late", "midnight", "after dark", "dark", "nuit", "minuit"],
  },
  {
    // "Sam's 30th", "Les 40 ans de Léa": a birthday with the word left out.
    skin: "zine",
    reason: "party",
    terms: [],
    patterns: [/(?:^| )\d{1,3}(?:st|nd|rd|th|e|eme)(?: |$)/, /(?:^| )\d{1,3} ans(?: |$)/],
  },
];

/** Whole-word matcher for one folded term, tolerant of a plain plural. */
function termPattern(term: string): RegExp {
  return new RegExp(`(?:^| )${term}(?:s|es)?(?: |$)`);
}

const COMPILED = SKIN_RULES.map((rule) => ({
  rule,
  patterns: [...rule.terms.map(termPattern), ...(rule.patterns ?? [])],
}));

/**
 * The skin to pre-select for a new board, and why. Free text in, one
 * of the 7 skin ids out; anything unrecognised is Paper with no reason.
 */
export function suggestSkin(title: string): SkinSuggestion {
  const folded = foldTitle(title);
  if (folded) {
    for (const { rule, patterns } of COMPILED) {
      if (patterns.some((pattern) => pattern.test(folded))) {
        return { skin: rule.skin, reason: rule.reason };
      }
    }
  }
  return { skin: DEFAULT_SKIN, reason: null };
}

export interface StartChoice {
  /** The skin the board is created with (always a free skin). */
  themeId: SkinId;
  /** A Plus skin to offer as a try-on right after creation, or null. */
  tryOn: SkinId | null;
}

/**
 * What the start flow creates for the look the person picked. A free
 * skin is simply used. A Plus skin is never stored on a board that has
 * not bought Plus: the board starts on the best free skin (the
 * suggestion when that is free, else Paper) and the picked Plus skin
 * becomes a try-on on the new board.
 */
export function startChoice(picked: SkinId, suggested: SkinId): StartChoice {
  if (!isPlusSkinId(picked)) return { themeId: picked, tryOn: null };
  return { themeId: isPlusSkinId(suggested) ? DEFAULT_SKIN : suggested, tryOn: picked };
}

/** Where to go once the board exists: its page, with the try-on when there is one. */
export function newBoardHref(slug: string, tryOn: SkinId | null): string {
  const base = `/g/${encodeURIComponent(slug)}`;
  return tryOn ? `${base}?tryon=${tryOn}` : base;
}
