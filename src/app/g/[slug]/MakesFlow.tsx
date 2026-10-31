"use client";

import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  billingBannerKind,
  creditCheckoutBody,
  makesState,
  parseBillingFlag,
  plusActionKey,
  readCreditCheckoutResponse,
  urlWithoutBilling,
  type BillingBannerKind,
  type BillingFlag,
  type CreditCheckoutErrorKind,
} from "../../../domain/makes-ui";
import type { PlusMode } from "../../../domain/plus";
import { plusPurchasePath } from "../../../domain/plus-ui";
import type { SkinId } from "../../../domain/skins";
import { t, tCount, tf, type Locale, type MessageKey } from "../../../i18n";
import { useLocale } from "../../../i18n/client";
import { Button, IconButton, cx } from "../../../ui";
import { boardQueryKey } from "./AddSheet";
import styles from "./board.module.css";
import { writeReturnSkin } from "./return-skin";

/** Refetches after a billing return before the banner stops waiting (display timing only). */
const BILLING_REFETCH_ATTEMPTS = 5;
const BILLING_REFETCH_MS = 2000;
/** How long the "creations are in" banner stays (display timing only). */
const ADDED_BANNER_MS = 8000;

const baselineKey = (slug: string) => `pinned.makesBaseline:${slug}`;

function readBaseline(slug: string, fallback: number | null): number | null {
  try {
    const raw = window.sessionStorage.getItem(baselineKey(slug));
    const parsed = raw === null ? NaN : Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeBaseline(slug: string, availableMakes: number | null) {
  try {
    if (availableMakes === null) window.sessionStorage.removeItem(baselineKey(slug));
    else window.sessionStorage.setItem(baselineKey(slug), String(availableMakes));
  } catch {
    // Private mode: the first-view count still works as the baseline.
  }
}

/** Drop `?billing=` once the banner has taken it, so a reload shows the board as it is. */
function clearBillingParam() {
  const next = urlWithoutBilling(window.location.href);
  if (next !== null) window.history.replaceState(window.history.state, "", next);
}

/**
 * The creations indicator (PIN-152, PIN-183; "creations" is the UI
 * word for makes). It speaks only when it matters: nothing while the
 * board view carries no credits (disabled = the shipped default) and
 * nothing while the board has more than `lowMakesWarning` left, so a
 * board with plenty looks like a credits-off board. At or under the
 * threshold it is one quiet line under the title ("N creations left
 * · Get Plus"); at zero it says new scenes will be collages. The
 * count rides the board poll, so spends and grants show up without a
 * reload, and a change is announced politely. The text button opens
 * the Plus sheet ("Add creations" once the board has Plus). The count
 * is always findable in the you menu.
 */
export function MakesIndicator({
  credits,
  lowMakesWarning,
  plusActive,
  canBuy,
  onAddMakes,
}: {
  credits: { availableMakes: number } | undefined;
  lowMakesWarning: number;
  plusActive: boolean;
  canBuy: boolean;
  onAddMakes: () => void;
}) {
  const locale = useLocale();
  if (!credits) return null;
  const state = makesState(credits.availableMakes, lowMakesWarning);
  if (state === "ok") return null;
  return (
    <p className={cx("pn-board-meta", styles.makes)} data-state={state} role="status" aria-live="polite">
      {state === "low" ? tCount(locale, "makes.left", credits.availableMakes) : t(locale, "makes.emptyLine")}
      {canBuy ? (
        <>
          {/* The dot stays with the sentence's last word when the line wraps. */}
          <span aria-hidden="true">&nbsp;·</span>{" "}
          <Button variant="quiet" size="sm" onClick={onAddMakes}>
            {t(locale, plusActionKey(plusActive))}
          </Button>
        </>
      ) : null}
    </p>
  );
}

/**
 * The billing-return banner (PIN-152): processing while the
 * webhook grant is still on its way, "in" only once the count
 * has actually risen (with "Plus is on" once the refetched view
 * says so, PIN-182), one neutral line for a checkout that
 * never finished. Live region, dismissible once settled.
 */
export function BillingBanner({
  kind,
  availableMakes,
  plusActive = false,
  onDismiss,
  locale = "en",
}: {
  kind: BillingBannerKind;
  availableMakes: number | null;
  plusActive?: boolean;
  onDismiss: () => void;
  locale?: Locale;
}) {
  const line =
    kind === "processing"
      ? t(locale, "makes.processing")
      : kind === "added"
        ? tf(locale, plusActive ? "makes.addedPlus" : "makes.added", {
            left: tCount(locale, "makes.left", availableMakes ?? 0),
          })
        : kind === "cancelled"
          ? t(locale, "makes.cancelled")
          : kind === "failed"
            ? t(locale, "makes.failedReturn")
            : t(locale, "makes.checkLater");
  return (
    <div className={styles.billingBanner} role="status" aria-live="polite" data-kind={kind}>
      <p>{line}</p>
      {kind !== "processing" ? (
        <IconButton icon="close" variant="ghost" size={18} label={t(locale, "ui.close")} onClick={onDismiss} />
      ) : null}
    </div>
  );
}

const CHECKOUT_ERROR_KEYS: Record<CreditCheckoutErrorKind, MessageKey> = {
  cap: "makes.errorCap",
  rate: "makes.errorRate",
  join: "makes.errorJoin",
  generic: "makes.errorGeneric",
};

/** The Plus sheet's inline line for a failed checkout call. */
export function checkoutErrorLine(error: CreditCheckoutErrorKind, locale: Locale = "en"): string {
  return t(locale, CHECKOUT_ERROR_KEYS[error]);
}

export interface MakesFlow {
  /** The Plus sheet can be opened and can sell (stripe) or demo (mock); false in off. */
  canBuy: boolean;
  sheetOpen: boolean;
  openSheet: () => void;
  closeSheet: () => void;
  busy: boolean;
  error: CreditCheckoutErrorKind | null;
  unavailable: boolean;
  /** Post the pack to the credits route and leave for hosted Checkout; `tryOn` is the look to bring back. */
  buy: (lookupKey: string, tryOn?: SkinId | null) => void;
  banner: BillingBannerKind | null;
  dismissBanner: () => void;
}

/**
 * The creations flow on the board (PIN-152, PIN-182): the Plus
 * sheet's open state, its stripe checkout call and the billing-return
 * banner. Buying posts the Policy pack to the PIN-149 route and
 * leaves for the hosted checkout URL it returns; the count at that
 * moment is kept (sessionStorage) so the return banner can tell a
 * real rise from a redirect that granted nothing, and so is the
 * Plus look the host was trying on, to put on the board once Plus
 * has landed.
 */
export function useMakesFlow({
  slug,
  availableMakes,
  initialAvailableMakes,
  plusMode,
  billingParam,
}: {
  slug: string;
  availableMakes: number | null;
  /** The server render's count: the fallback return baseline. */
  initialAvailableMakes: number | null;
  plusMode: PlusMode | undefined;
  /** `?billing=` from the return redirector (validated here). */
  billingParam: unknown;
}): MakesFlow {
  const queryClient = useQueryClient();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<CreditCheckoutErrorKind | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [flag] = useState<BillingFlag | null>(() => parseBillingFlag(billingParam));
  // First paint must match the server render: start from the
  // server count everywhere, then adopt the stored buy-time
  // count after mount (sessionStorage differs after a fast
  // webhook grant, and reading it during render would
  // hydrate mismatched banner markup).
  const [baseline, setBaseline] = useState<number | null>(initialAvailableMakes);
  useEffect(() => {
    const stored = readBaseline(slug, null);
    if (stored !== null) setBaseline(stored);
  }, [slug]);
  const [exhausted, setExhausted] = useState(
    false
  );

  const [dismissed, setDismissed] = useState(false);
  const buying = useRef(false);

  // The banner owns the flag now: strip it so reloads and
  // shares never replay a stale return.
  useEffect(() => {
    if (flag) clearBillingParam();
  }, [flag]);

  const banner = dismissed
    ? null
    : billingBannerKind({ flag, baseline, current: availableMakes, exhausted });

  // A few quick refetches while the grant is on its way (the
  // board poll keeps going after, at its own cadence).
  useEffect(() => {
    if (banner !== "processing") return;
    let attempts = 0;
    const timer = window.setInterval(() => {
      attempts += 1;
      void queryClient.invalidateQueries({ queryKey: boardQueryKey(slug) });
      if (attempts >= BILLING_REFETCH_ATTEMPTS) {
        window.clearInterval(timer);
        setExhausted(true);
      }
    }, BILLING_REFETCH_MS);
    return () => window.clearInterval(timer);
  }, [banner, queryClient, slug]);

  // The grant landed: drop the stored baseline and let the
  // confirmation fade on its own.
  useEffect(() => {
    if (banner !== "added") return;
    writeBaseline(slug, null);
    const timer = window.setTimeout(() => setDismissed(true), ADDED_BANNER_MS);
    return () => window.clearTimeout(timer);
  }, [banner, slug]);

  async function startCheckout(lookupKey: string, tryOn: SkinId | null) {
    if (buying.current || plusPurchasePath(plusMode) !== "stripe") return;
    buying.current = true;
    setBusy(true);
    setError(null);
    writeBaseline(slug, availableMakes);
    writeReturnSkin(slug, tryOn);
    try {
      const response = await fetch(`/api/boards/${encodeURIComponent(slug)}/credits/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(creditCheckoutBody(lookupKey)),
      });
      const body: unknown = await response.json().catch(() => null);
      const result = readCreditCheckoutResponse(response.status, body);
      if (result.kind === "redirect") {
        // Stays busy while the browser leaves for checkout.
        window.location.href = result.url;
        return;
      }
      buying.current = false;
      setBusy(false);
      writeReturnSkin(slug, null);
      if (result.kind === "unavailable") setUnavailable(true);
      else setError(result.error);
    } catch {
      buying.current = false;
      setBusy(false);
      writeReturnSkin(slug, null);
      setError("generic");
    }
  }

  return {
    canBuy: plusPurchasePath(plusMode) !== "none",
    sheetOpen,
    openSheet: () => {
      setError(null);
      setUnavailable(false);
      setSheetOpen(true);
    },
    closeSheet: () => {
      if (busy) return;
      setError(null);
      setUnavailable(false);
      setSheetOpen(false);
    },
    busy,
    error,
    unavailable,
    buy: (lookupKey, tryOn = null) => void startCheckout(lookupKey, tryOn),
    banner,
    dismissBanner: () => setDismissed(true),
  };
}
