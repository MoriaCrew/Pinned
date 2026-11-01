/**
 * Board themes (PIN-52). The PIN-41 preset illustrations and their
 * palettes survive the Studio pivot as pure looks: a theme is art +
 * design tokens + a motif, never a host. Theme ids match the ids
 * stored on pre-pivot games (`presetId`) so existing boards keep
 * their art; new boards store the same id as `themeId`.
 *
 * PIN-96: boards now wear design-system skins (`./skins`). A skin id
 * is a valid stored `themeId` too; these first-generation themes stay
 * readable and render through `skinForTheme`.
 */
import { isSkinId } from "./skins";

export interface BoardThemeTokens {
  accent: string;
  accentInk: string;
  paper: string;
  line: string;
  motif: string;
}

export interface BoardTheme {
  id: string;
  label: string;
  motif: string;
  /** Baked illustration (PIN-41): /themes/<id>.webp */
  image: string;
  tokens: BoardThemeTokens;
}

export const BOARD_THEMES: readonly BoardTheme[] = [
  {
    id: "helpdesk",
    label: "Helpdesk",
    motif: "🛠️",
    image: "/themes/helpdesk.webp",
    tokens: { accent: "#2563eb", accentInk: "#ffffff", paper: "#eef4ff", line: "#c7d6f5", motif: "🛠️" },
  },
  {
    id: "gran",
    label: "Gran",
    motif: "👵",
    image: "/themes/gran.webp",
    tokens: { accent: "#b3541e", accentInk: "#ffffff", paper: "#fff6ea", line: "#ecd9bd", motif: "👵" },
  },
  {
    id: "commentator",
    label: "Commentator",
    motif: "🎙️",
    image: "/themes/commentator.webp",
    tokens: { accent: "#15803d", accentInk: "#ffffff", paper: "#ecfdf3", line: "#bfe8cc", motif: "🎙️" },
  },
  {
    id: "chef",
    label: "Chef",
    motif: "👨‍🍳",
    image: "/themes/chef.webp",
    tokens: { accent: "#dc2626", accentInk: "#ffffff", paper: "#fff1f0", line: "#f3c6c2", motif: "👨‍🍳" },
  },
  {
    id: "pirate",
    label: "Pirate",
    motif: "🏴‍☠️",
    image: "/themes/pirate.webp",
    tokens: { accent: "#0f766e", accentInk: "#ffffff", paper: "#ecfeff", line: "#b7e3e0", motif: "🏴‍☠️" },
  },
  {
    id: "detective",
    label: "Detective",
    motif: "🔎",
    image: "/themes/detective.webp",
    tokens: { accent: "#334155", accentInk: "#ffffff", paper: "#f1f5f9", line: "#cbd5e1", motif: "🔎" },
  },
  {
    id: "cat",
    label: "Cat",
    motif: "🐱",
    image: "/themes/cat.webp",
    tokens: { accent: "#9333ea", accentInk: "#ffffff", paper: "#faf5ff", line: "#e2ccf7", motif: "🐱" },
  },
  {
    id: "astronaut",
    label: "Astronaut",
    motif: "🚀",
    image: "/themes/astronaut.webp",
    tokens: { accent: "#1d4ed8", accentInk: "#ffffff", paper: "#eff6ff", line: "#bfdbfe", motif: "🚀" },
  },
] as const;

export function getBoardTheme(id: string | undefined | null): BoardTheme | null {
  if (!id) return null;
  return BOARD_THEMES.find((theme) => theme.id === id) ?? null;
}

/** A storable board look: a design-system skin id or a first-generation theme id. */
export function isBoardThemeId(value: unknown): value is string {
  return isSkinId(value) || (typeof value === "string" && getBoardTheme(value) !== null);
}

/**
 * Theme id for a stored board. Pre-pivot games stored the id as
 * `presetId`; read both so old boards keep their look (the stored
 * field is renamed for good when PIN-66 replaces the page).
 */
export function storedThemeId(stored: {
  themeId?: string;
  presetId?: string;
}): string | undefined {
  return stored.themeId ?? stored.presetId;
}

const PLAYER_COLORS = ["#c2410c", "#2563eb", "#15803d", "#9333ea", "#db2777", "#0f766e", "#b45309", "#475569"] as const;

function hashSeed(seed: string): number {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Stable per-player color from the shared palette. */
export function playerColorFor(playerId: string): string {
  return PLAYER_COLORS[hashSeed(playerId) % PLAYER_COLORS.length];
}
