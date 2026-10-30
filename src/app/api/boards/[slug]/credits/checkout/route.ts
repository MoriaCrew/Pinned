import { NextResponse } from "next/server";
import { getCreditCheckout } from "../../../../../../billing/server";
import { getConfig } from "../../../../../../config";
import { getPolicy } from "../../../../../../policy/server";
import { getBoardRepository } from "../../../../../../server/board-repository";
import { getCheckoutIntentStore } from "../../../../../../server/checkout-intent-store";
import {
  CreditCheckoutError,
  buyCredits,
} from "../../../../../../server/credit-checkout";
import { getCreditLedgerStore } from "../../../../../../server/credit-ledger-store";
import { hostTokenFrom, verifyHostToken } from "../../../../../../server/host-session";
import { getPublicOrigin } from "../../../../../../server/public-origin";
import {
  readJsonCapped,
  rateLimit,
  rejectCrossSite,
  requireJson,
} from "../../../request-guards";
import {
  JSON_HEADERS,
  errorResponse,
  notFound,
  policyForBoard,
  slugGate,
  viewerFor,
} from "../../../shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CHECKOUT_SCOPE = "board-credits-checkout";

function creditErrorResponse(error: unknown): NextResponse {
  if (error instanceof CreditCheckoutError) {
    if (error.status === 404) return notFound();
    return NextResponse.json(
      { error: error.message, ...(error.code ? { code: error.code } : {}) },
      { status: error.status, headers: JSON_HEADERS },
    );
  }
  return errorResponse(error, "Checkout is not available right now. Please try again.");
}

/**
 * Buy a makes pack (PIN-149): JSON { lookupKey } -> 200
 * { status: "redirect", url } | { status: "unavailable" }.
 * Gates in order: bad slug 404; cross-site 403, non-JSON 415,
 * per-IP 429 (Policy.credits.checkoutPerIp), body 413; then a
 * joined board participant (existing board session) or the
 * board host - anyone holding the link who has joined may pay
 * as a guest at Stripe, nobody else mints checkout intents.
 * The per-board pending cap is enforced in the intent store.
 * PLUS_MODE off/mock answers "unavailable" and writes nothing.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await context.params;
  const gated = slugGate(slug);
  if (gated) return gated;
  const envPolicy = getPolicy();
  const refused =
    rejectCrossSite(request) ??
    requireJson(request) ??
    rateLimit(request, CHECKOUT_SCOPE, envPolicy.credits.checkoutPerIp);
  if (refused) return refused;
  const body = await readJsonCapped(request, envPolicy.plus.requestMaxBytes);
  if (!body.ok) return body.response;
  try {
    const policy = await policyForBoard(slug);
    const viewer = await viewerFor(request, slug, policy);
    if (!viewer) {
      const board = await getBoardRepository().getBoard(slug);
      const isHost =
        board !== null &&
        verifyHostToken(board, hostTokenFrom(request, slug), policy, Date.now());
      if (!isHost) {
        return NextResponse.json(
          { error: "Join this board before buying makes.", code: "participant_required" },
          { status: 401, headers: JSON_HEADERS },
        );
      }
    }
    const result = await buyCredits(slug, body.value, {
      boards: getBoardRepository(),
      policy,
      plusMode: getConfig().plusMode,
      intents: getCheckoutIntentStore(),
      ledger: getCreditLedgerStore(),
      creditCheckout: getCreditCheckout(),
      returnBaseUrl: getPublicOrigin(request, getConfig().appBaseUrl),
    });
    return NextResponse.json(result, { headers: JSON_HEADERS });
  } catch (error) {
    return creditErrorResponse(error);
  }
}
