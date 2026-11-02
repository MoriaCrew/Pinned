export const REPORT_REF_PREFIX: "pinned-report-v1:";
export const REPORT_REF_HEX: number;

export function boardReportRef(slug: string): string;
export function parseFindArgs(
  argv: readonly string[],
): { ok: true; project: string; ref: string } | { ok: false; error: string };
export function matchReportRef(slugs: readonly string[], ref: string): string[];
