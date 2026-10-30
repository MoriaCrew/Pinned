"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  billingBannerKind,
  canBuyMakes,
  creditCheckoutBody,
  formatEur,
  formatPerMake,
  makesState,
  parseBillingFlag,
  readCreditCheckoutResponse,
  urlWithoutBilling,
  type BillingBannerKind,
  type BillingFlag,
  type CreditCheckoutErrorKind,
  type MakesPack,
} from "../../../domain/makes-ui";
import type { PlusMode } from "../../../domain/plus";
import { t, tCount, tf, type Locale, type MessageKey } from "../../../i18n";
import { Button, Icon, IconButton, Sheet } from "../../../ui";
import { boardQueryKey } from "./AddSheet";
import styles from "./board.module.css";

/** Refetches after a billing return before the banner stops waiting (display timing only). */
const BILLING_REFETCH_ATTEMPTS = 5;
const BILLING_REFETCH_MS = 2000;
/** How long the "makes are in" banner stays (display timing only). */
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
 * The makes indicator (PIN-152): how many makes this board has
 * left, for everyone on it. Renders nothing at all while the
 * board view carries no credits (disabled = the shipped
 * default), so a credits-off board looks exactly as before.
 * The count rides the board poll, so spends and grants show
 * up without a reload; changes are announced politely.
 */
export function MakesIndicator({
  credits,
  lowMakesWarning,
  canBuy,
  onAddMakes,
  locale = "en",
}: {
  credits: { availableMakes: number } | undefined;
  lowMakesWarning: number;
  canBuy: boolean;
  onAddMakes: () => void;
  locale?: Locale;
}) {
  if (!credits) return null;
  const state = makesState(credits.availableMakes, lowMakesWarning);
  return (
    <div className={styles.makes} data-state={state} aria-live="polite">
      <p className={styles.makesCount}>{tCount(locale, "makes.left", credits.availableMakes)}</p>
      {state === "low" ? <p className={styles.makesNote}>{t(locale, "makes.lowLine")}</p> : null}
      {state === "empty" ? <p className={styles.makesNote}>{t(locale, "makes.collageNote")}</p> : null}
      {canBuy ? (
        <Button size="sm" variant={state === "ok" ? "secondary" : "primary"} onClick={onAddMakes}>
          {t(locale, "makes.add")}
        </Button>
      ) : null}
    </div>
  );
}

/**
 * The billing-return banner (PIN-152): processing while the
 * webhook grant is still on its way, "in" only once the count
 * has actually risen, one neutral line for a checkout that
 * never finished. Live region, dismissible once settled.
 */
export function BillingBanner({
  kind,
  availableMakes,
  onDismiss,
  locale = "en",
}: {
  kind: BillingBannerKind;
  availableMakes: number | null;
  onDismiss: () => void;
  locale?: Locale;
}) {
  const line =
    kind === "processing"
      ? t(locale, "makes.processing")
      : kind === "added"
        ? tf(locale, "makes.added", { left: tCount(locale, "makes.left", availableMakes ?? 0) })
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

/**
 * The buy sheet (PIN-152): the Policy packs as a radio group
 * (the Plus sheet's plan pattern), EUR tax-included prices,
 * a per-make line in plain words, the local-currency note
 * and the statement name. Anyone on the board can add makes
 * for the board. With buying unavailable (off/mock) the
 * sheet says so plainly and sells nothing.
 */
export function MakesBuySheet({
  packs,
  canBuy,
  busy = false,
  error = null,
  unavailable = false,
  onBuy,
  onClose,
  locale = "en",
}: {
  packs: MakesPack[];
  canBuy: boolean;
  busy?: boolean;
  error?: CreditCheckoutErrorKind | null;
  /** The checkout route answered "unavailable": show the not-open line. */
  unavailable?: boolean;
  onBuy: (lookupKey: string) => void;
  onClose: () => void;
  locale?: Locale;
}) {
  const packGroup = `makes-pack-${useId()}`;
  const [selectedKey, setSelectedKey] = useState<string | null>(packs[0]?.lookupKey ?? null);
  const selected = packs.find((pack) => pack.lookupKey === selectedKey) ?? packs[0] ?? null;
  const available = canBuy && !unavailable && selected !== null;
  return (
    <Sheet
      title={t(locale, "makes.title")}
      onClose={onClose}
      footer={
        <>
          <Button
            variant="primary"
            size="lg"
            block
            disabled={!available || busy}
            onClick={() => selected && onBuy(selected.lookupKey)}
          >
            {busy
              ? t(locale, "makes.buying")
              : selected
                ? tf(locale, "makes.buy", {
                    pack: tCount(locale, "makes.packCount", selected.credits),
                    price: formatEur(selected.eurCents, locale),
                  })
                : t(locale, "makes.add")}
          </Button>
          {!available ? <p className={styles.makesSheetNote}>{t(locale, "makes.unavailable")}</p> : null}
          <Button variant="quiet" block onClick={onClose}>
            {t(locale, "ui.notNow")}
          </Button>
        </>
      }
    >
      <p className={styles.makesLead}>{t(locale, "makes.lead")}</p>
      <fieldset className="pn-plans">
        <legend className="pn-sr">{t(locale, "makes.title")}</legend>
        {packs.map((pack) => (
          <label key={pack.lookupKey} className="pn-plan">
            <input
              type="radio"
              name={packGroup}
              value={pack.lookupKey}
              checked={selected?.lookupKey === pack.lookupKey}
              onChange={() => setSelectedKey(pack.lookupKey)}
            />
            <span className="pn-plan-name">{tCount(locale, "makes.packCount", pack.credits)}</span>
            <span className="pn-plan-price">{tf(locale, "makes.priceTtc", { price: formatEur(pack.eurCents, locale) })}</span>
            <span className="pn-plan-note">{tf(locale, "makes.perMake", { price: formatPerMake(pack, locale) })}</span>
            <span className="pn-plan-check" aria-hidden="true">
              <Icon name="check" size={14} strokeWidth={2.5} />
            </span>
          </label>
        ))}
      </fieldset>
      <p className={styles.makesSheetNote}>{t(locale, "makes.localCurrency")}</p>
      <p className={styles.makesSheetNote}>{t(locale, "makes.statement")}</p>
      <p className={styles.makesError} role="alert">
        {error ? t(locale, CHECKOUT_ERROR_KEYS[error]) : ""}
      </p>
    </Sheet>
  );
}

/**
 * Out-of-makes outcome line (PIN-152): make-aware copy where
 * a photo or scene stopped at the empty pool, with the way
 * into the buy sheet when buying can actually work.
 */
export function MakesPoolEmpty({
  kind,
  canBuy,
  onAddMakes,
  locale = "en",
}: {
  kind: "photo" | "scene";
  canBuy: boolean;
  onAddMakes: () => void;
  locale?: Locale;
}) {
  return (
    <div className={styles.makesPoolEmpty} role="alert">
      <p>{t(locale, kind === "photo" ? "makes.poolEmptyPhoto" : "makes.poolEmptyScene")}</p>
      {canBuy ? (
        <Button size="sm" variant="primary" onClick={onAddMakes}>
          {t(locale, "makes.add")}
        </Button>
      ) : null}
    </div>
  );
}

export interface MakesFlow {
  canBuy: boolean;
  sheetOpen: boolean;
  openSheet: () => void;
  closeSheet: () => void;
  busy: boolean;
  error: CreditCheckoutErrorKind | null;
  unavailable: boolean;
  buy: (lookupKey: string) => void;
  banner: BillingBannerKind | null;
  dismissBanner: () => void;
}

/**
 * The makes flow on the board (PIN-152): the buy sheet's
 * checkout call and the billing-return banner. Buying posts
 * the chosen pack to the PIN-149 route and leaves for the
 * hosted checkout URL it returns; the count at that moment
 * is kept (sessionStorage) so the return banner can tell a
 * real rise from a redirect that granted nothing.
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
  const [baseline] = useState<number | null>(() =>
    typeof window === "undefined" ? initialAvailableMakes : readBaseline(slug, initialAvailableMakes),
  );
  const [exhausted, setExhausted] = useState(false);
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

  async function startCheckout(lookupKey: string) {
    if (buying.current || !canBuyMakes(plusMode)) return;
    buying.current = true;
    setBusy(true);
    setError(null);
    writeBaseline(slug, availableMakes);
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
      if (result.kind === "unavailable") setUnavailable(true);
      else setError(result.error);
    } catch {
      buying.current = false;
      setBusy(false);
      setError("generic");
    }
  }

  return {
    canBuy: canBuyMakes(plusMode),
    sheetOpen,
    openSheet: () => {
      setError(null);
      setUnavailable(false);
      setSheetOpen(true);
    },
    closeSheet: () => {
      if (!busy) setSheetOpen(false);
    },
    busy,
    error,
    unavailable,
    buy: (lookupKey) => void startCheckout(lookupKey),
    banner,
    dismissBanner: () => setDismissed(true),
  };
}
