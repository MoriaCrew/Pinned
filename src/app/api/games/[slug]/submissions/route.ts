import { NextResponse } from "next/server";
import { getConfig } from "../../../../../config";
import { getDerivativeStore } from "../../../../../server/derivative-store";
import { MAX_PHOTO_BYTES, PhotoIntakeError } from "../../../../../server/photo-intake";
import {
  playerCookieName,
  readCookieValue,
} from "../../../../../server/player-session";
import { getGameRepository } from "../../../../../server/repository";
import {
  SubmitPhotoError,
  getOwnSubmission,
  publicOwnSubmission,
  submitPhoto,
} from "../../../../../server/submit-photo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const JSON_HEADERS = { "Cache-Control": "no-store" };

function sessionDeps() {
  return {
    repository: getGameRepository(),
    sessionSecret: getConfig().sessionSecret,
  };
}

export async function GET(
  request: Request,
  context: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await context.params;
  const cookie = readCookieValue(request.headers.get("cookie"), playerCookieName(slug));
  const own = await getOwnSubmission(slug, cookie, sessionDeps());
  if (!own) {
    return NextResponse.json(
      { error: "Join this game before submitting a photo." },
      { status: 401, headers: JSON_HEADERS },
    );
  }
  return NextResponse.json(
    { submission: own.submission ? publicOwnSubmission(own.submission) : null },
    { headers: JSON_HEADERS },
  );
}

export async function POST(
  request: Request,
  context: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_PHOTO_BYTES + 1024 * 1024) {
    return NextResponse.json(
      { error: "That photo is too large. Keep it under 10 MB." },
      { status: 413, headers: JSON_HEADERS },
    );
  }

  let photo: File | null = null;
  try {
    const form = await request.formData();
    const value = form.get("photo");
    if (value instanceof File) photo = value;
  } catch {
    return NextResponse.json(
      { error: "Send the photo as a form upload." },
      { status: 400, headers: JSON_HEADERS },
    );
  }
  if (!photo || photo.size === 0) {
    return NextResponse.json(
      { error: "Choose a photo to upload." },
      { status: 400, headers: JSON_HEADERS },
    );
  }

  try {
    const { slug } = await context.params;
    const cookie = readCookieValue(request.headers.get("cookie"), playerCookieName(slug));
    const bytes = new Uint8Array(await photo.arrayBuffer());
    const result = await submitPhoto(slug, cookie, bytes, {
      ...sessionDeps(),
      store: getDerivativeStore(),
    });
    return NextResponse.json(
      {
        submission: publicOwnSubmission(result.submission),
        outcome: result.outcome,
        width: result.width,
        height: result.height,
      },
      { status: result.outcome === "created" ? 201 : 200, headers: JSON_HEADERS },
    );
  } catch (error) {
    if (error instanceof PhotoIntakeError || error instanceof SubmitPhotoError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status, headers: JSON_HEADERS },
      );
    }
    console.error("photo submission failed", error);
    return NextResponse.json(
      { error: "That photo could not be submitted. Please try again." },
      { status: 500, headers: JSON_HEADERS },
    );
  }
}
