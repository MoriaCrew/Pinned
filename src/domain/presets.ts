/**
 * Curated host presets (PIN-39, docs/09 decisions 1-2).
 *
 * Each preset is a complete, pre-baked bundle: persona, challenge
 * pool, theme tokens, and player colors. Creating from a preset
 * needs no typing and no model call — instant and free. Every
 * persona carries the canonical roast boundary ("never the
 * person"), enforced again here by construction.
 */
import type { HostPersona } from "../gateway/model-gateway";

export interface GameTheme {
  accent: string;
  accentInk: string;
  paper: string;
  line: string;
  motif: string;
}

export interface HostPreset {
  id: string;
  motif: string;
  catchline: string;
  persona: HostPersona;
  challenges: readonly string[];
  theme: GameTheme;
  playerColors: readonly string[];
}

const ROAST_RULE = "Roast the photo, effort and timing — never the person.";

function persona(
  name: string,
  voiceRule: string,
  catchphrases: string[],
  judgingStyle: string,
): HostPersona {
  return {
    name,
    language: "en",
    voiceRules: [voiceRule, ROAST_RULE],
    catchphrases,
    judgingStyle,
  };
}

const PLAYER_COLORS = ["#c2410c", "#2563eb", "#15803d", "#9333ea", "#db2777", "#0f766e", "#b45309", "#475569"] as const;

export const HOST_PRESETS: readonly HostPreset[] = [
  {
    id: "helpdesk",
    motif: "🛠️",
    catchline: "Ticket opened. Patience closed.",
    persona: persona(
      "Greg from IT",
      "Deadpan helpdesk energy; everything is a ticket with an ID and a severity.",
      ["Ticket updated.", "Have you tried… trying?"],
      "Rubric-first, evidence like a ticket log.",
    ),
    challenges: [
      "Find the most suspicious object on your desk.",
      "Photograph the object you'd blame first when tech fails.",
      "Show me the cable situation you pretend is fine.",
    ],
    theme: { accent: "#2563eb", accentInk: "#ffffff", paper: "#eef4ff", line: "#c7d6f5", motif: "🛠️" },
    playerColors: PLAYER_COLORS,
  },
  {
    id: "gran",
    motif: "👵",
    catchline: "She has seen better. In 1962.",
    persona: persona(
      "Gran Rose",
      "Unimpressed grandmother; compares everything to how things were done properly.",
      ["In my day…", "Bless. Next."],
      "Rubric-first, judged against impossible nostalgic standards.",
    ),
    challenges: [
      "Find the oldest thing you own that still works.",
      "Photograph something you'd never show your grandmother.",
      "Show me the snack you'd offer a guest right now.",
    ],
    theme: { accent: "#b3541e", accentInk: "#ffffff", paper: "#fff6ea", line: "#ecd9bd", motif: "👵" },
    playerColors: PLAYER_COLORS,
  },
  {
    id: "commentator",
    motif: "🎙️",
    catchline: "It's a cup final. Everything is.",
    persona: persona(
      "The Commentator",
      "Full sports-commentary drama; every object is a title contender or a shock defeat.",
      ["UNBELIEVABLE SCENES!", "The crowd goes mild!"],
      "Rubric-first, scored like a match report.",
    ),
    challenges: [
      "Find the MVP of the room you're in.",
      "Photograph an object that has clearly given up.",
      "Show me your home-ground advantage.",
    ],
    theme: { accent: "#15803d", accentInk: "#ffffff", paper: "#ecfdf3", line: "#bfe8cc", motif: "🎙️" },
    playerColors: PLAYER_COLORS,
  },
  {
    id: "chef",
    motif: "👨‍🍳",
    catchline: "Plating: tragic. Effort: pending.",
    persona: persona(
      "Chef Marcel",
      "Theatrical head chef; judges objects like dishes on presentation and seasoning.",
      ["Where is the seasoning?!", "Service, please."],
      "Rubric-first, like a tasting-menu verdict.",
    ),
    challenges: [
      "Plate up the most mysterious thing in your kitchen.",
      "Find an ingredient whose story you cannot explain.",
      "Show me the utensil you use for everything except its job.",
    ],
    theme: { accent: "#dc2626", accentInk: "#ffffff", paper: "#fff1f0", line: "#f3c6c2", motif: "👨‍🍳" },
    playerColors: PLAYER_COLORS,
  },
  {
    id: "pirate",
    motif: "🏴‍☠️",
    catchline: "All treasure be judged equally.",
    persona: persona(
      "Cap'n Brine",
      "Salty pirate captain; objects are plunder, loot, or driftwood fit for the deep.",
      ["Arrr, noted in the log.", "To the brig with it."],
      "Rubric-first, weighed like plunder at port.",
    ),
    challenges: [
      "Show me the finest treasure within arm's reach.",
      "Photograph something that belongs at the bottom of the sea.",
      "Find your most loyal shipmate (object edition).",
    ],
    theme: { accent: "#0f766e", accentInk: "#ffffff", paper: "#ecfeff", line: "#b7e3e0", motif: "🏴‍☠️" },
    playerColors: PLAYER_COLORS,
  },
  {
    id: "detective",
    motif: "🔎",
    catchline: "Every object is a suspect.",
    persona: persona(
      "Inspector Vale",
      "Noir detective; treats each entry as evidence and narrates accordingly.",
      ["The evidence suggests…", "Case notes updated."],
      "Rubric-first, argued like a closing statement.",
    ),
    challenges: [
      "Photograph the most suspicious object near you. No context.",
      "Find an object with an alibi problem.",
      "Show me the clue you'd leave at a crime scene by accident.",
    ],
    theme: { accent: "#334155", accentInk: "#ffffff", paper: "#f1f5f9", line: "#cbd5e1", motif: "🔎" },
    playerColors: PLAYER_COLORS,
  },
  {
    id: "cat",
    motif: "🐱",
    catchline: "You may present your offering.",
    persona: persona(
      "Sir Whiskers",
      "Aloof cat overlord; humans bring offerings, most are beneath notice.",
      ["Acceptable. Barely.", "This pleases the management."],
      "Rubric-first, delivered between naps.",
    ),
    challenges: [
      "Bring an offering worthy of sitting on.",
      "Find the warmest-looking spot in the building.",
      "Photograph something you would knock off a table.",
    ],
    theme: { accent: "#9333ea", accentInk: "#ffffff", paper: "#faf5ff", line: "#e2ccf7", motif: "🐱" },
    playerColors: PLAYER_COLORS,
  },
  {
    id: "astronaut",
    motif: "🚀",
    catchline: "Houston, we have an entry.",
    persona: persona(
      "Major Nova",
      "Calm mission-control astronaut; logs each object like a specimen from orbit.",
      ["Copy that.", "Telemetry looks… unusual."],
      "Rubric-first, reported like a mission log.",
    ),
    challenges: [
      "Photograph an object that looks like alien technology.",
      "Find your most mission-critical tool.",
      "Show me something that would confuse mission control.",
    ],
    theme: { accent: "#1d4ed8", accentInk: "#ffffff", paper: "#eff6ff", line: "#bfdbfe", motif: "🚀" },
    playerColors: PLAYER_COLORS,
  },
] as const;

export const PRESET_PROMPT_VERSION = "preset.v1";

export function getPreset(id: string | undefined | null): HostPreset | null {
  if (!id) return null;
  return HOST_PRESETS.find((preset) => preset.id === id) ?? null;
}

export function isPresetId(value: unknown): value is string {
  return typeof value === "string" && getPreset(value) !== null;
}

function hashSeed(seed: string): number {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Deterministic per-game pick so retries/rematches stay stable. */
export function pickPresetChallenge(preset: HostPreset, seed: string): string {
  return preset.challenges[hashSeed(seed) % preset.challenges.length];
}

/** Stable per-player color from the shared palette. */
export function playerColorFor(playerId: string): string {
  return PLAYER_COLORS[hashSeed(playerId) % PLAYER_COLORS.length];
}

/** Fallback themes for invented hosts, picked deterministically. */
export const CUSTOM_THEMES: readonly GameTheme[] = HOST_PRESETS.map((p) => p.theme);

export function themeForCustomGame(seed: string): GameTheme {
  const base = CUSTOM_THEMES[hashSeed(seed) % CUSTOM_THEMES.length];
  return { ...base, motif: "✨" };
}
