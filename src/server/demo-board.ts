import "server-only";
/**
 * Per-visitor demo boards (PIN-251, docs/DEPLOY.md §6.3): "See a
 * board" on the landing gives each visitor a fresh board cloned from
 * the DEMO_BOARD_SLUG template, hosted by that visitor, and gone once
 * Policy.demo.ttlHours have passed (the sweep is PIN-255).
 *
 * This is a board-creation path outside the per-maker free creations
 * rule (PIN-205), so it has its own brakes, all from Policy.demo and
 * all failing closed: a durable per-address claim and a durable total
 * claim on the StarterAllowanceStore (the maker-rule counter, under
 * demo-prefixed keys so a demo never spends a maker slot), and a pool
 * of `demo.starterMakes` free creations instead of `credits.starterMakes`.
 * No store, a store error, or a cap reached: no demo board.
 *
 * The clone is the pure plan in src/domain/demo-clone.ts, written
 * record by record through the ordinary repository methods (each one
 * its own transaction, in Firestore). A failure half-way tombstones
 * the new board and sweeps its storage, so a visitor never lands on a
 * partial board. The template is only read; its files are shared by
 * reference (cut-outs) or copied (scene pictures), never moved.
 */
import { randomUUID } from "node:crypto";
import { planDemoClone, type DemoClonePlan } from "../domain/demo-clone";
import { generateAdminToken, generateSlug, hashToken } from "../domain/tokens";
import type { UserRepository } from "../domain/user-repository";
import { MAX_SLUG_ATTEMPTS, type BoardApiDeps, type CreatedBoard } from "./board-api";
import { unlinkMyBoards } from "./board-delete";
import { BoardApiError } from "./board-session";
import { sweepDeletedBoardStorage } from "./board-storage";
import { ensureStarterMakes } from "./credit-pool";
import { issueHostCredential } from "./host-session";
import { logServerError } from "./safe-log";

/** Typed codes on the BoardApiError the route maps to its redirects. */
export const DEMO_CAPPED = "demo_capped";
export const DEMO_UNAVAILABLE = "demo_unavailable";

/** The one shared counter every demo creation claims against (Policy.demo.maxTotal). */
export const DEMO_TOTAL_KEY = "demo:total";

/** Per-address counter key (Policy.demo.maxPerIp); `clientKey` is already a hash, never a raw address. */
export function demoClientCapKey(clientKey: string): string {
  return `demo:ip:${clientKey}`;
}

const HOUR_MS = 60 * 60 * 1000;

export type DemoBoardDeps = Pick<
  BoardApiDeps,
  "boards" | "store" | "credits" | "starterAllowance" | "policy" | "now" | "createSlug" | "newId" | "newHostToken"
> & {
  /** My boards rows of swept demo boards are unlinked here (PIN-255). */
  users: UserRepository;
};

export interface CreateDemoBoardContext {
  /** The template board (DEMO_BOARD_SLUG). */
  templateSlug: string;
  /** The new board's title, in the visitor's language. */
  title: string;
  /** Opaque hashed client key (src/domain/maker-key.ts), never a raw address. */
  clientKey: string;
}

/**
 * Create one demo board for a visitor. Throws BoardApiError 503
 * `demo_unavailable` when the template is missing, 429 `demo_capped`
 * when a Policy.demo cap refuses (nothing is written then), and lets
 * any other failure propagate after rolling the new board back.
 */
export async function createDemoBoard(
  context: CreateDemoBoardContext,
  deps: DemoBoardDeps,
): Promise<CreatedBoard> {
  const now = deps.now?.() ?? Date.now();
  const { demo } = deps.policy;
  const template = await deps.boards.getBoard(context.templateSlug);
  if (!template) throw new BoardApiError("Demo unavailable.", 503, DEMO_UNAVAILABLE);
  // The template exists: now spend a slot. The order means a broken
  // template never burns the visitor's allowance.
  await claimDemoSlot(context.clientKey, now, deps);

  const [participants, elements, pins, scenes] = await Promise.all([
    deps.boards.listParticipants(template.slug),
    deps.boards.listElements(template.slug),
    deps.boards.listPins(template.slug, "pinned"),
    deps.boards.listScenes(template.slug),
  ]);
  const expiresAt = now + demo.ttlHours * HOUR_MS;

  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
    const credential = issueHostCredential(now, deps.newHostToken);
    const plan = planDemoClone(
      { template, participants, elements, pins, scenes },
      {
        slug: deps.createSlug?.() ?? generateSlug(),
        title: context.title,
        now,
        expiresAt,
        host: credential.record,
        starterMakes: demo.starterMakes,
        freePhotos: demo.freePhotos,
        newId: deps.newId ?? randomUUID,
        // A hash of a token that is dropped right here: no cookie can ever match it.
        newCookieSecretHash: () => hashToken(generateAdminToken()),
      },
    );
    try {
      await deps.boards.createBoard(plan.board);
    } catch (error) {
      if (error instanceof RangeError && attempt < MAX_SLUG_ATTEMPTS - 1) continue;
      throw error;
    }
    await fillDemoBoard(plan, deps, now);
    // PIN-151/PIN-205 shape, with the demo pool: never blocks creation,
    // and the lazy grant on the first credit touch reads the same
    // amount back from the board doc.
    await ensureStarterMakes(plan.board.slug, deps, demo.starterMakes).catch(() => undefined);
    // The visitor's board exists; now the sweep-on-request half
    // (PIN-255): this creation pays for at most `sweepBatch` expired
    // ones, after the claim so refused requests do no work for free.
    await sweepExpiredDemoBoards(deps, now);
    return { board: plan.board, hostToken: credential.token };
  }
  throw new BoardApiError("Demo unavailable.", 503, DEMO_UNAVAILABLE);
}

export interface DemoSweepResult {
  /** Expired demo boards the query returned. */
  listed: number;
  /** Boards this call tombstoned (and then unlinked and swept). */
  deleted: number;
}

/**
 * Delete expired demo boards (PIN-255, docs/11 A4 sweep-on-request):
 * the repository lists live boards whose `demoSweepAt` is past, and
 * only those: an ordinary board has no `demoSweepAt`, so it can never
 * be listed, and the extra `demo` check here is belt and braces. For
 * each: the tombstone (the same `deleteBoard` the host uses, which
 * drops the sweep key), then the My boards unlink and the storage
 * sweep, exactly the host-delete order (board-delete.ts). Best-effort
 * and idempotent: never throws into the creation path, logs by error
 * name only, and whatever one run misses the next one finds.
 */
export async function sweepExpiredDemoBoards(deps: DemoBoardDeps, now: number): Promise<DemoSweepResult> {
  const result: DemoSweepResult = { listed: 0, deleted: 0 };
  const batch = deps.policy.demo.sweepBatch;
  if (batch <= 0) return result;
  try {
    const expired = await deps.boards.listDemoBoardsToSweep(now, batch);
    result.listed = expired.length;
    for (const board of expired) {
      if (board.demo === undefined || board.demoSweepAt === undefined || board.demoSweepAt >= now) continue;
      if (!(await deps.boards.deleteBoard(board.slug, now))) continue;
      result.deleted += 1;
      await unlinkMyBoards(board.slug, deps);
      await sweepDeletedBoardStorage(board.slug, deps);
    }
  } catch (error) {
    logServerError("demo board sweep stopped early", error);
  }
  return result;
}

/**
 * Both durable claims. Order matters because a claim is spent even
 * when the other one refuses: the shared total is peeked first (a
 * read, nothing recorded), so a full or closed demo never burns a
 * visitor's per-address slots; then the per-address claim (the cheap
 * refusal for one abuser, who therefore cannot drain the total); then
 * the total claim itself, which only a race since the peek can
 * refuse. A denied claim records nothing, so retries cannot stretch a
 * window (starter-allowance semantics); `maxPerIp` or `maxTotal` at 0
 * closes the demo entirely. Any doubt is a refusal.
 */
async function claimDemoSlot(clientKey: string, now: number, deps: DemoBoardDeps): Promise<void> {
  const capped = () => new BoardApiError("Demo boards are busy.", 429, DEMO_CAPPED);
  const store = deps.starterAllowance;
  if (!store) throw capped();
  const { maxPerIp, maxTotal, windowMs } = deps.policy.demo;
  const total = { maxBoards: maxTotal, windowMs };
  let allowed = false;
  try {
    allowed =
      (await store.hasSlot(DEMO_TOTAL_KEY, now, total)) &&
      (await store.tryClaim(demoClientCapKey(clientKey), now, { maxBoards: maxPerIp, windowMs })) &&
      (await store.tryClaim(DEMO_TOTAL_KEY, now, total));
  } catch (error) {
    logServerError("demo cap claim failed", error);
    throw capped();
  }
  if (!allowed) throw capped();
}

/**
 * Write the plan in dependency order: roster, things, pins, then the
 * scenes whose picture copy landed (a scene without its picture is
 * left out rather than shown broken). Any repository failure rolls the
 * board back: tombstone first, so no one can reach it, then its
 * storage; the template's shared cut-outs are kept by the sweep's own
 * shared-asset rule.
 */
async function fillDemoBoard(plan: DemoClonePlan, deps: DemoBoardDeps, now: number): Promise<void> {
  const slug = plan.board.slug;
  try {
    for (const participant of plan.participants) await deps.boards.putParticipant(participant);
    for (const element of plan.elements) await deps.boards.createElement(element);
    for (const pin of plan.pins) await deps.boards.createPin(pin);
    const copied = new Set<string>();
    for (const copy of plan.copies) {
      try {
        await deps.store.copy(copy.from, copy.to);
        copied.add(copy.to);
      } catch (error) {
        logServerError("demo scene picture copy failed", error);
      }
    }
    for (const scene of plan.scenes) {
      if (scene.imageRef && copied.has(scene.imageRef)) await deps.boards.putScene(scene);
    }
  } catch (error) {
    await deps.boards.deleteBoard(slug, now).catch(() => false);
    await sweepDeletedBoardStorage(slug, deps);
    throw error;
  }
}
