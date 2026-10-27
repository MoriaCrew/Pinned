/**
 * Deadline presets (FR1.1). Pure epoch-ms math. `timeZoneOffsetMinutes`
 * follows Date.getTimezoneOffset(): minutes to add to local time to get UTC.
 */
export type DeadlinePreset = "express" | "evening" | "24h" | "custom";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export interface ResolveDeadlineInput {
  now: number;
  preset: DeadlinePreset;
  customHours?: number;
  timeZoneOffsetMinutes?: number;
}

function assertFiniteNow(now: number): void {
  if (!Number.isFinite(now)) throw new RangeError("Current time must be finite");
}

function eveningDeadline(now: number, offsetMinutes: number): number {
  if (!Number.isInteger(offsetMinutes) || offsetMinutes < -840 || offsetMinutes > 840) {
    throw new RangeError("Time zone offset must be an integer between -840 and 840");
  }
  // Represent local wall time as a UTC timestamp, set it to 21:00, then
  // convert back to epoch time.
  const localWall = new Date(now - offsetMinutes * MINUTE_MS);
  localWall.setUTCHours(21, 0, 0, 0);
  let deadline = localWall.getTime() + offsetMinutes * MINUTE_MS;
  if (deadline <= now) deadline += DAY_MS;
  return deadline;
}

export function resolveDeadline(input: ResolveDeadlineInput): number {
  assertFiniteNow(input.now);
  switch (input.preset) {
    case "express":
      return input.now + 2 * HOUR_MS;
    case "24h":
      return input.now + DAY_MS;
    case "evening":
      return eveningDeadline(input.now, input.timeZoneOffsetMinutes ?? 0);
    case "custom": {
      const hours = input.customHours;
      if (!Number.isInteger(hours) || hours === undefined || hours < 1 || hours > 72) {
        throw new RangeError("Custom deadline must be a whole number of hours between 1 and 72");
      }
      return input.now + hours * HOUR_MS;
    }
    default:
      throw new RangeError("Unknown deadline preset");
  }
}
