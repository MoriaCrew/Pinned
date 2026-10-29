import { NextResponse } from "next/server";
import { getBoardRepository } from "../../../../../../server/board-repository";
import { getDerivativeStore } from "../../../../../../server/derivative-store";
import { resolveOwnedElementImage } from "../../../../../../server/my-pins";
import { authDisabledGate, currentUser } from "../../../../auth-shared";
import { notFound } from "../../../../boards/shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Owner-checked library thumbnail (?kind=cutout|flattened,
 * PIN-85). Authorization is signed-in OWNERSHIP — the element's
 * owner participant must be claimed by the caller — never a
 * board link, and the URL carries no board slug. Every miss
 * (link-only mode, signed out, another user's element, unknown
 * id) is the same uniform 404: no existence or slug leak.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ elementId: string }> },
): Promise<NextResponse> {
  const gated = authDisabledGate();
  if (gated) return gated;
  const { elementId } = await context.params;
  const kind = new URL(request.url).searchParams.get("kind");
  const user = await currentUser(request).catch(() => null);
  const image = await resolveOwnedElementImage(user, elementId, kind, {
    boards: getBoardRepository(),
    store: getDerivativeStore(),
  }).catch(() => null);
  if (!image) return notFound();
  return new NextResponse(new Uint8Array(image.bytes), {
    headers: {
      "Content-Type": image.contentType,
      "Content-Length": String(image.bytes.length),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
