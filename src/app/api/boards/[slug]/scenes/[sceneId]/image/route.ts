import { NextResponse } from "next/server";
import { resolveSceneImage } from "../../../../../../../server/board-api";
import {
  boardApiDeps,
  notFound,
  policyForBoard,
  slugGate,
} from "../../../../shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Board-link-checked scene image. The slug IS the capability
 * link; the scene must belong to that board, be ready and not
 * hidden. Every miss is the same 404 — no existence leak.
 * Chat crawlers fetching og:image (PIN-72) may cache privately
 * for Policy.sceneImageCacheMaxAgeSeconds; no-store would make
 * some crawlers drop the preview, and shared caches stay out.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ slug: string; sceneId: string }> },
): Promise<NextResponse> {
  const { slug, sceneId } = await context.params;
  const gated = slugGate(slug);
  if (gated) return gated;
  const policy = await policyForBoard(slug);
  const image = await resolveSceneImage(slug, sceneId, boardApiDeps(policy));
  if (!image) return notFound();
  return new NextResponse(new Uint8Array(image.bytes), {
    headers: {
      "Content-Type": image.contentType,
      "Content-Length": String(image.bytes.length),
      "Cache-Control": `private, max-age=${policy.sceneImageCacheMaxAgeSeconds}`,
      "X-Content-Type-Options": "nosniff",
    },
  });
}
