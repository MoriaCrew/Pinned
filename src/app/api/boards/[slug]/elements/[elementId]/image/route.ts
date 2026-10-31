import { NextResponse } from "next/server";
import { resolveElementImage } from "../../../../../../../server/board-api";
import {
  boardApiDeps,
  notFound,
  policyForBoard,
  slugGate,
} from "../../../../shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Board-link-checked element image (?kind=cutout|flattened).
 * The slug IS the capability link; the element must belong to
 * that board. Every miss is the same 404 — no existence leak.
 * Cut-outs are immutable once made (a rename changes only the
 * label), so a hit may be cached privately, in the browser only,
 * for Policy.elementImageCacheSeconds (PIN-217): the link check
 * still runs on every request that reaches the server.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ slug: string; elementId: string }> },
): Promise<NextResponse> {
  const { slug, elementId } = await context.params;
  const gated = slugGate(slug);
  if (gated) return gated;
  const kind = new URL(request.url).searchParams.get("kind");
  const policy = await policyForBoard(slug);
  const image = await resolveElementImage(slug, elementId, kind, boardApiDeps(policy));
  if (!image) return notFound();
  return new NextResponse(new Uint8Array(image.bytes), {
    headers: {
      "Content-Type": image.contentType,
      "Content-Length": String(image.bytes.length),
      "Cache-Control": `private, max-age=${policy.elementImageCacheSeconds}`,
      "X-Content-Type-Options": "nosniff",
    },
  });
}
