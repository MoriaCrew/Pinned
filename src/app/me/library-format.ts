import { formatDate, t, tCount, type Locale } from "../../i18n";
import type { IconName } from "../../ui";

/** "Oct 29": the day of a board's latest activity (UTC, so server and tests agree). */
export function formatShortDate(locale: Locale, epochMs: number): string {
  return formatDate(locale, epochMs, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** The two mono lines on a My boards card: "3 things of yours" and the last active day ("Oct 29"). */
export function boardCardMeta(
  locale: Locale,
  myPinCount: number,
  lastActivityAt: number,
): { mine: string; last: string } {
  return {
    mine: tCount(locale, "myBoards.mine", myPinCount),
    last: formatShortDate(locale, lastActivityAt),
  };
}

export type PinButtonState = "idle" | "pinning" | "pinned" | "already" | "failed";

export interface PinButtonView {
  label: string;
  icon: IconName | undefined;
  /** Not clickable now (in flight or already on the board). */
  inert: boolean;
  /** On the board: shown as a settled state, not a disabled button. */
  done: boolean;
}

/**
 * What the Pin here button shows in each state. Words only for
 * state (no emoji); a failed pin stays clickable so the label
 * "Try again" is also the action.
 */
export function pinButtonView(locale: Locale, state: PinButtonState): PinButtonView {
  switch (state) {
    case "pinning":
      return { label: t(locale, "myPins.pinning"), icon: undefined, inert: true, done: false };
    case "pinned":
      return { label: t(locale, "myPins.pinned"), icon: "check", inert: true, done: true };
    case "already":
      return { label: t(locale, "myPins.alreadyPinned"), icon: "check", inert: true, done: true };
    case "failed":
      return { label: t(locale, "myPins.failed"), icon: "undo", inert: false, done: false };
    default:
      return { label: t(locale, "myPins.pinToBoard"), icon: "pin", inert: false, done: false };
  }
}
