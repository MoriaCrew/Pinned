import { NextResponse } from "next/server";
import { getConfig } from "../../../config";

/** Liveness + non-secret mode readout (NFR6). Never include secret values. */
export function GET() {
  const cfg = getConfig();
  return NextResponse.json({
    ok: true,
    service: "pinned",
    authMode: cfg.authMode,
    aiMock: cfg.aiMock,
  });
}
