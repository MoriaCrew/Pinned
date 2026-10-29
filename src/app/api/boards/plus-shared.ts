import { NextResponse } from "next/server";
import { getConfig } from "../../../config";
import { BoardPlusError } from "../../../server/board-plus";
import { isHostRequest } from "../../../server/host-session";
import { JSON_HEADERS, errorResponse, notFound } from "./shared";

/** Host cookie -> boolean for this board (PIN-103); false without a secret. */
export function hostFor(request: Request, slug: string): boolean {
  return isHostRequest(request, slug, getConfig().sessionSecret);
}

/** Unparseable JSON is just "no input": the service still checks host first. */
export async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/**
 * BoardPlusError -> { error, code } with its 400/402/403 status
 * (404 stays the uniform body); everything else falls through to
 * the shared board-API mapping.
 */
export function plusErrorResponse(error: unknown, fallback: string): NextResponse {
  if (error instanceof BoardPlusError) {
    if (error.status === 404) return notFound();
    return NextResponse.json(
      { error: error.message, ...(error.code ? { code: error.code } : {}) },
      { status: error.status, headers: JSON_HEADERS },
    );
  }
  return errorResponse(error, fallback);
}
