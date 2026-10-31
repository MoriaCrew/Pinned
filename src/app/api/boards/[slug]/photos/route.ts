import { NextResponse } from "next/server";
import { t, tf } from "../../../../../i18n";
import { getLocale } from "../../../../../i18n/server";
import { publicJob, uploadPhoto } from "../../../../../server/board-api";
import { MAX_PHOTO_BYTES } from "../../../../../server/photo-intake";
import { RATE_LIMITS, checkRateLimit, clientKey } from "../../../../../server/rate-limit";
import {
  JSON_HEADERS,
  boardApiDeps,
  errorResponse,
  policyForBoard,
  slugGate,
  viewerFor,
} from "../../shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Upload one photo (multipart field "photo") and run its
 * DecomposeJob in-request. Client contract (docs/11 section 5.8):
 * downscale on the client before upload; the server still bounds
 * and re-encodes everything through photo-intake, and the original
 * bytes are never stored. Poll GET /jobs/[jobId] for pop-in. An
 * optional "uploadId" field (the client's per-file UUID) makes the
 * POST idempotent: it becomes the job id, so the client can poll
 * during the POST and a lost response retries into the same job
 * (200 replay, never a second make).
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const locale = await getLocale();
  const { slug } = await context.params;
  const maxPhotoMb = Math.round(MAX_PHOTO_BYTES / (1024 * 1024));
  const gated = slugGate(slug);
  if (gated) return gated;

  const gate = RATE_LIMITS.submissionsPerIpGame;
  if (!checkRateLimit(`${clientKey(request, "photos")}:${slug}`, gate.limit, gate.windowMs)) {
    return NextResponse.json(
      { error: t(locale, "request.tooManyAttempts") },
      { status: 429, headers: JSON_HEADERS },
    );
  }
  const uploadGate = RATE_LIMITS.uploadsPerIp;
  if (!checkRateLimit(clientKey(request, "upload"), uploadGate.limit, uploadGate.windowMs)) {
    return NextResponse.json(
      { error: t(locale, "request.tooManyUploads") },
      { status: 429, headers: JSON_HEADERS },
    );
  }

  const lengthHeader = request.headers.get("content-length");
  const contentLength = Number(lengthHeader ?? NaN);
  if (!lengthHeader || !Number.isFinite(contentLength) || contentLength <= 0) {
    return NextResponse.json(
      { error: t(locale, "request.photoNeedsLength") },
      { status: 411, headers: JSON_HEADERS },
    );
  }
  if (contentLength > MAX_PHOTO_BYTES + 1024 * 1024) {
    return NextResponse.json(
      { error: tf(locale, "request.photoTooLarge", { max: maxPhotoMb }) },
      { status: 413, headers: JSON_HEADERS },
    );
  }

  let photo: File | null = null;
  let uploadId: string | undefined;
  try {
    const form = await request.formData();
    const value = form.get("photo");
    if (value instanceof File) photo = value;
    const rawUploadId = form.get("uploadId");
    if (typeof rawUploadId === "string" && rawUploadId) uploadId = rawUploadId;
  } catch {
    return NextResponse.json(
      { error: t(locale, "request.photoFormUpload") },
      { status: 400, headers: JSON_HEADERS },
    );
  }
  if (!photo || photo.size === 0) {
    return NextResponse.json(
      { error: t(locale, "request.choosePhoto") },
      { status: 400, headers: JSON_HEADERS },
    );
  }
  if (photo.size > MAX_PHOTO_BYTES) {
    return NextResponse.json(
      { error: tf(locale, "request.photoTooLarge", { max: maxPhotoMb }) },
      { status: 413, headers: JSON_HEADERS },
    );
  }

  try {
    const policy = await policyForBoard(slug);
    const viewer = await viewerFor(request, slug, policy);
    if (!viewer) {
      return NextResponse.json(
        { error: t(locale, "request.joinBeforePhoto") },
        { status: 401, headers: JSON_HEADERS },
      );
    }
    const bytes = new Uint8Array(await photo.arrayBuffer());
    const job = await uploadPhoto(slug, viewer, bytes, boardApiDeps(policy), uploadId);
    return NextResponse.json(
      { job: publicJob(job) },
      { status: job.replayed ? 200 : 201, headers: JSON_HEADERS },
    );
  } catch (error) {
    return errorResponse(error, t(locale, "request.addPhotoFailed"));
  }
}
