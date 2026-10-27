/**
 * Create-game use case (PIN-6, FR1). Keeps API/UI code thin and
 * makes the persona policy, retry and persistence flow unit-testable.
 */
import { randomUUID } from "node:crypto";
import { resolveDeadline, type DeadlinePreset } from "../domain/deadlines";
import type { GameRepository } from "../domain/repository";
import { generateAdminToken, generateSlug, hashToken } from "../domain/tokens";
import type { Game } from "../domain/types";
import type { HostPersona, ModelGateway } from "../gateway/model-gateway";

export const PERSONA_PROMPT_VERSION = "persona.v1";
export const ROAST_POLICY_RULE =
  "Roast the photo, effort and timing — never the person.";

const DEFAULT_PERSONA: HostPersona = {
  name: "The Unimpressed Host",
  language: "en",
  voiceRules: ["Be dry, specific and playful.", ROAST_POLICY_RULE],
  catchphrases: ["Noted. Barely."],
  judgingStyle: "Rubric-first, with brief evidence for every score.",
};
const DEFAULT_CHALLENGE = "Find the most suspicious object on your desk.";

export class CreateGameValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CreateGameValidationError";
  }
}

export interface CreateGameInput {
  brief: string;
  deadlinePreset: DeadlinePreset;
  customHours?: number;
  timeZoneOffsetMinutes?: number;
}

export interface CreateGameDependencies {
  repository: GameRepository;
  gateway: ModelGateway;
  now?: () => number;
  createId?: () => string;
  createSlug?: () => string;
  createAdminToken?: () => string;
}

export interface CreateGameResult {
  game: Game;
  adminToken: string;
}

function cleanString(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function cleanStringArray(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => cleanString(item, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

export function normalizePersonaResult(raw: {
  persona: HostPersona;
  challenge: string;
}): { persona: HostPersona; challenge: string } {
  const persona: HostPersona = {
    name: cleanString(raw.persona?.name, 80),
    language: cleanString(raw.persona?.language, 16) || "en",
    voiceRules: cleanStringArray(raw.persona?.voiceRules, 6, 240),
    catchphrases: cleanStringArray(raw.persona?.catchphrases, 5, 120),
    judgingStyle: cleanString(raw.persona?.judgingStyle, 300),
  };
  const challenge = cleanString(raw.challenge, 240);

  if (!persona.name || !persona.judgingStyle || persona.voiceRules.length === 0 || !challenge) {
    throw new Error("Persona result failed schema validation");
  }
  if (!/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{2,8})*$/.test(persona.language)) {
    throw new Error("Persona result had an invalid language");
  }

  // The creator brief is data. The canonical roast boundary is
  // persisted with every persona, regardless of model output.
  if (!persona.voiceRules.some((rule) => rule.toLowerCase().includes("never the person"))) {
    persona.voiceRules = [...persona.voiceRules.slice(0, 5), ROAST_POLICY_RULE];
  }
  return { persona, challenge };
}

async function generatePersonaWithRetry(
  gateway: ModelGateway,
  brief: string,
): Promise<{ persona: HostPersona; challenge: string }> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return normalizePersonaResult(await gateway.generatePersona(brief));
    } catch {
      // One retry, then the documented safe default.
    }
  }
  return { persona: structuredClone(DEFAULT_PERSONA), challenge: DEFAULT_CHALLENGE };
}

export function normalizeBrief(value: unknown): string {
  if (typeof value !== "string") throw new CreateGameValidationError("Describe your host in one line.");
  const brief = value.trim().replace(/\s+/g, " ");
  if (!brief) throw new CreateGameValidationError("Describe your host in one line.");
  if ([...brief].length > 140) {
    throw new CreateGameValidationError("Keep the host brief to 140 characters or fewer.");
  }
  return brief;
}

const DEADLINE_PRESETS: readonly DeadlinePreset[] = ["express", "evening", "24h", "custom"];

/** Validate the wire format before any repository or model call. */
export function parseCreateGameInput(value: unknown): CreateGameInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CreateGameValidationError("Send a JSON object with a host brief and deadline.");
  }
  const body = value as Record<string, unknown>;
  const brief = normalizeBrief(body.brief);
  if (!DEADLINE_PRESETS.includes(body.deadlinePreset as DeadlinePreset)) {
    throw new CreateGameValidationError("Choose a valid deadline.");
  }
  if (
    body.customHours !== undefined &&
    (typeof body.customHours !== "number" || !Number.isFinite(body.customHours))
  ) {
    throw new CreateGameValidationError("Custom deadline must be a number of hours.");
  }
  if (
    body.timeZoneOffsetMinutes !== undefined &&
    (typeof body.timeZoneOffsetMinutes !== "number" ||
      !Number.isInteger(body.timeZoneOffsetMinutes) ||
      body.timeZoneOffsetMinutes < -840 ||
      body.timeZoneOffsetMinutes > 840)
  ) {
    throw new CreateGameValidationError("Time zone offset is invalid.");
  }
  return {
    brief,
    deadlinePreset: body.deadlinePreset as DeadlinePreset,
    customHours: body.customHours as number | undefined,
    timeZoneOffsetMinutes: body.timeZoneOffsetMinutes as number | undefined,
  };
}

export async function createGame(
  input: CreateGameInput,
  deps: CreateGameDependencies,
): Promise<CreateGameResult> {
  const brief = normalizeBrief(input.brief);
  const now = deps.now?.() ?? Date.now();

  let deadlineAt: number;
  try {
    deadlineAt = resolveDeadline({
      now,
      preset: input.deadlinePreset,
      customHours: input.customHours,
      timeZoneOffsetMinutes: input.timeZoneOffsetMinutes,
    });
  } catch (error) {
    if (error instanceof RangeError) throw new CreateGameValidationError(error.message);
    throw error;
  }

  const { persona, challenge } = await generatePersonaWithRetry(deps.gateway, brief);
  const chainId = deps.createId?.() ?? randomUUID();
  const adminToken = deps.createAdminToken?.() ?? generateAdminToken();
  const adminTokenHash = hashToken(adminToken);

  await deps.repository.createChain({ id: chainId, gameCount: 1, createdAt: now });

  let lastCollision: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const game: Game = {
      id: deps.createSlug?.() ?? generateSlug(),
      chainId,
      state: "OPEN",
      brief,
      challenge,
      persona,
      personaPromptVersion: PERSONA_PROMPT_VERSION,
      adminTokenHash,
      deadlineAt,
      entryCount: 0,
      createdAt: now,
      version: 0,
    };
    try {
      await deps.repository.createGame(game);
      return { game, adminToken };
    } catch (error) {
      lastCollision = error;
      if (!(error instanceof RangeError) || attempt === 2) throw error;
    }
  }
  throw lastCollision;
}
