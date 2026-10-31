import { NextResponse } from "next/server";
import { publicBoard } from "../../../../../server/board-api";
import { changeBoardSkin, resolveSkinActor } from "../../../../../server/board-plus";
import { hostRouteDeps, hostRouteGate, plusErrorResponse } from "../../plus-shared";
import { JSON_HEADERS, policyForBoard, slugGate, viewerFor } from "../../shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Change the board skin (PIN-103): JSON { skinId } -> 200 { board }.
 * Bad slug 404; then the I/O-free gates (cross-site 403, non-JSON
 * 415, per-IP 429, body over Policy 413, no host or board session
 * cookie 403); then the credential against the loaded board: the
 * host (token vs stored hash + age), or since PIN-181 a joined
 * member while the board has Plus. Anything else, unknown boards
 * too, is the same 403 host_only. Then unknown skin 400, Plus skin
 * without an entitlement that counts 402 { error, code:
 * "plus_required" }. Choosing the current skin is a no-op 200.
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await context.params;
  const gated = slugGate(slug);
  if (gated) return gated;
  try {
    const gate = await hostRouteGate(request, slug, { allowMember: true });
    if (!gate.ok) return gate.response;
    const policy = await policyForBoard(slug);
    const deps = hostRouteDeps(policy);
    const isMember = async () => (await viewerFor(request, slug, policy)) !== null;
    const actor = await resolveSkinActor(slug, gate.hostToken, isMember, deps);
    const board = await changeBoardSkin(slug, actor, gate.body, deps);
    return NextResponse.json({ board: publicBoard(board) }, { headers: JSON_HEADERS });
  } catch (error) {
    return plusErrorResponse(error, "Could not change the skin. Please try again.");
  }
}
