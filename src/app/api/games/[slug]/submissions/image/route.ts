import { NextResponse } from "next/server";
import { getConfig } from "../../../../../../config";
import { getDerivativeStore } from "../../../../../../server/derivative-store";
import { WORKING_IMAGE_CONTENT_TYPE } from "../../../../../../server/photo-intake";
import {
  playerCookieName,
  readCookieValue,
} from "../../../../../../server/player-session";
import { getGameRepository } from "../../../../../../server/repository";
import { getOwnSubmission } from "../../../../../../server/submit-photo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Owner-only preview of the player's own working derivative. */
export async function GET(
  request: Request,
  context: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await context.params;
  const cookie = readCookieValue(request.headers.get("cookie"), playerCookieName(slug));
  const own = await getOwnSubmission(slug, cookie, {
    repository: getGameRepository(),
    sessionSecret: getConfig().sessionSecret,
  });
  if (!own) {
    return NextResponse.json({ error: "Not joined." }, { status: 401 });
  }
  const kind = new URL(request.url).searchParams.get("kind");
  const isCutout = kind === "cutout";
  const ref = isCutout ? own.submission?.cutoutRef : own.submission?.workingRef;
  if (!ref) {
    return NextResponse.json({ error: "No photo yet." }, { status: 404 });
  }
  const bytes = await getDerivativeStore().get(ref);
  if (!bytes) {
    return NextResponse.json({ error: "Photo unavailable." }, { status: 404 });
  }
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "Content-Type": isCutout ? "image/png" : WORKING_IMAGE_CONTENT_TYPE,
      "Content-Length": String(bytes.length),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
