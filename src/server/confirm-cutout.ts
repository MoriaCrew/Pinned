/**
 * Cut-out confirmation actions (PIN-47 / PIN-8C).
 * accept: no-op confirm. whole: drop the cut-out (record + object).
 * point: tap-reselect via the segment service (attempt-capped).
 */
import type { GameRepository } from "../domain/repository";
import type { Submission } from "../domain/types";
import type { ModelGateway } from "../gateway/model-gateway";
import type { DerivativeStore } from "./derivative-store";
import { resolvePlayerSession } from "./player-session";
import { SegmentSubmissionError, segmentSubmission } from "./segment-submission";

export type CutoutAction =
  | { action: "accept" }
  | { action: "whole" }
  | { action: "point"; point: { x: number; y: number } };

export class CutoutConfirmError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 401 | 404 | 409 | 429 | 502 = 400,
  ) {
    super(message);
    this.name = "CutoutConfirmError";
  }
}

export function parseCutoutAction(value: unknown): CutoutAction {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CutoutConfirmError("Send a cut-out action.");
  }
  const body = value as Record<string, unknown>;
  if (body.action === "accept") return { action: "accept" };
  if (body.action === "whole") return { action: "whole" };
  if (body.action === "point") {
    const point = body.point as { x?: unknown; y?: unknown } | undefined;
    const x = point?.x;
    const y = point?.y;
    if (typeof x !== "number" || typeof y !== "number" || x < 0 || x > 1 || y < 0 || y > 1) {
      throw new CutoutConfirmError("Tap a point on the photo (0 to 1).");
    }
    return { action: "point", point: { x, y } };
  }
  throw new CutoutConfirmError("Choose accept, whole, or point.");
}

export interface CutoutConfirmDeps {
  repository: GameRepository;
  sessionSecret: string | null;
  gateway: ModelGateway;
  store: DerivativeStore;
}

async function ownActive(
  slug: string,
  cookieValue: string | null,
  deps: { repository: GameRepository; sessionSecret: string | null },
): Promise<Submission> {
  const player = await resolvePlayerSession(slug, cookieValue, deps);
  if (!player) throw new CutoutConfirmError("Join this game first.", 401);
  const all = await deps.repository.listSubmissions(slug);
  const own = all.find((entry) => entry.playerId === player.id && entry.status === "active");
  if (!own) throw new CutoutConfirmError("Submit a photo first.", 404);
  return own;
}

export async function confirmCutout(
  slug: string,
  cookieValue: string | null,
  action: CutoutAction,
  deps: CutoutConfirmDeps,
): Promise<{ submission: Submission; outcome: string }> {
  const own = await ownActive(slug, cookieValue, deps);

  if (action.action === "accept") {
    if (!own.cutoutRef) throw new CutoutConfirmError("There is no cut-out to accept yet.", 409);
    return { submission: own, outcome: "accepted" };
  }

  if (action.action === "whole") {
    const fresh = (await deps.repository.listSubmissions(slug)).find((entry) => entry.id === own.id);
    if (!fresh || fresh.status !== "active") {
      throw new CutoutConfirmError("This entry changed just now. Refresh and try again.", 409);
    }
    if (fresh.cutoutRef) await deps.store.delete(fresh.cutoutRef).catch(() => undefined);
    const updated: Submission = { ...fresh, cutoutRef: undefined };
    await deps.repository.putSubmission(updated);
    return { submission: updated, outcome: "whole" };
  }

  try {
    const result = await segmentSubmission(slug, own.id, deps, { point: action.point });
    return { submission: result.submission, outcome: result.outcome };
  } catch (error) {
    if (error instanceof SegmentSubmissionError) {
      throw new CutoutConfirmError(error.message, error.status);
    }
    throw error;
  }
}
