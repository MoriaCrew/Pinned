"use client";

import { useEffect, useReducer, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { BillingFlag } from "../../../domain/makes-ui";
import type { PlusView } from "../../../domain/plus";
import {
  activeTryOn,
  chooseLook,
  effectiveSkin,
  initialLookFlow,
  keepStep,
  lookFlow,
  parseTryOn,
  plusPurchasePath,
  plusSheetLocked,
  closesPlusSheetAfterMock,
  type MockGrantOutcome,
  readCheckoutResponse,
  readSkinResponse,
  returnSkinStep,
  showTryOnBar,
  urlWithoutTryOn,
  type CheckoutResult,
  type LookFlowState,
  type LookNotice,
  type SkinResult,
} from "../../../domain/plus-ui";
import type { SkinId } from "../../../domain/skins";
import { t, tf, type Locale } from "../../../i18n";
import { useLocale } from "../../../i18n/client";
import { IconButton, PlusSheet, TryOnBar, cx, skinName, type PlusPack } from "../../../ui";
import { boardQueryKey } from "./AddSheet";
import type { BoardClientView } from "./BoardClient";
import { ChangeLookSheet } from "./ChangeLookSheet";
import { checkoutErrorLine, type MakesFlow } from "./MakesFlow";
import { markReturnSkinReturned, readReturnSkin, writeReturnSkin } from "./return-skin";
import styles from "./board.module.css";

/** How long a confirmation line stays above the dock (display timing only). */
const LOOK_NOTICE_MS = 3000;

const JSON_REQUEST = {
  headers: { "Content-Type": "application/json" },
  credentials: "same-origin",
} as const;

/** Drop `?tryon=` once a try-on ends, so a reload shows the board as it is. */
function clearTryOnParam() {
  const next = urlWithoutTryOn(window.location.href);
  if (next !== null) window.history.replaceState(window.history.state, "", next);
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export interface LookFlow {
  state: LookFlowState;
  /** The skin the board root renders right now. */
  shownSkin: SkinId;
  /** The Plus look the host is trying on (null for guests and when none). */
  tryOn: SkinId | null;
  openLook: () => void;
  closeSheet: () => void;
  pickLook: (skin: SkinId) => void;
  keep: () => void;
  undo: () => void;
  /** The mock checkout (POST plus, host only); resolves true once Plus was granted. */
  getPlus: () => Promise<MockGrantOutcome>;
  dismissNotice: () => void;
}

/**
 * Board Plus on the board (PIN-111, docs/15): the host's Change
 * look, the local Plus try-on and Keep it. The server decides
 * (host cookie, entitlement, PLUS_MODE); this keeps the screen
 * honest about it: a free look shows at once and reverts on error,
 * a try-on is local until kept, Keep it asks for Plus only when
 * the board lacks it, and billing "off" never sells anything.
 * Back from a Stripe checkout (PIN-182) it puts the look the host
 * was trying on onto the board, once Plus has landed.
 */
export function useLookFlow({
  slug,
  boardSkin,
  isHost,
  plus,
  tryOnParam,
  billingFlag,
}: {
  slug: string;
  boardSkin: SkinId;
  isHost: boolean;
  plus: PlusView | undefined;
  /** `?tryon=` from the link (validated again here). */
  tryOnParam: unknown;
  /** `?billing=` from the billing return, validated by the caller. */
  billingFlag: BillingFlag | null;
}): LookFlow {
  const queryClient = useQueryClient();
  const [state, dispatch] = useReducer(lookFlow, initialLookFlow);
  const key = boardQueryKey(slug);
  const tryOn = activeTryOn(boardSkin, state.tryOn, isHost);
  const shownSkin = (isHost ? state.applying : null) ?? effectiveSkin(boardSkin, state.tryOn, isHost);

  // ?tryon= from the start flow: once, as soon as the first poll
  // says this browser is the host (the server render cannot know).
  const tryOnParamHandled = useRef(false);
  useEffect(() => {
    if (tryOnParamHandled.current || !isHost) return;
    tryOnParamHandled.current = true;
    const skin = parseTryOn(tryOnParam, isHost, boardSkin);
    if (skin) dispatch({ type: "tryOn", skin });
    else clearTryOnParam();
  }, [isHost, tryOnParam, boardSkin]);

  // Back from Stripe (PIN-182): the host's try-on goes onto the board
  // once the refetched view says Plus counts (the webhook lands after
  // the redirect; the flag may already be gone). The stored look is
  // forgotten only once the save has answered; a failed save hands the
  // look back to the try-on bar so Keep it can retry. Once only.
  const returnHandled = useRef(false);
  // Landing with the processing flag marks the stored look as returned
  // from Checkout, so a reload before the webhook lands still applies it.
  useEffect(() => {
    if (billingFlag === "processing") markReturnSkinReturned(slug);
  }, [billingFlag, slug]);
  useEffect(() => {
    if (returnHandled.current) return;
    const step = returnSkinStep({
      flag: billingFlag,
      stored: readReturnSkin(slug),
      isHost,
      plusActive: plus?.active === true,
      boardSkin,
    });
    if (step.kind === "wait") return;
    returnHandled.current = true;
    if (step.kind === "clear") {
      writeReturnSkin(slug, null);
      return;
    }
    void applySkin(step.skin).then((outcome) => {
      writeReturnSkin(slug, null);
      // A failed save keeps its notice and hands the look back to the
      // try-on bar; plusRequired already opened the Plus sheet with it.
      if (outcome === "failed") dispatch({ type: "retryTryOn", skin: step.skin });
    });
    // applySkin only closes over the query client, the slug and dispatch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [billingFlag, slug, isHost, plus?.active, boardSkin]);

  // A confirmation fades; an error stays until dismissed or replaced.
  const notice = state.notice;
  useEffect(() => {
    if (!notice || (notice.kind !== "applied" && notice.kind !== "granted")) return;
    const timer = window.setTimeout(() => dispatch({ type: "dismissNotice" }), LOOK_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  async function patchSkin(skin: SkinId): Promise<SkinResult> {
    try {
      const response = await fetch(`/api/boards/${encodeURIComponent(slug)}/skin`, {
        ...JSON_REQUEST,
        method: "PATCH",
        body: JSON.stringify({ skinId: skin }),
      });
      return readSkinResponse(response.status, await readJson(response));
    } catch {
      return { kind: "failed" };
    }
  }

  async function applySkin(skin: SkinId): Promise<SkinResult["kind"]> {
    dispatch({ type: "applyStart", skin });
    const result = await patchSkin(skin);
    if (result.kind === "applied") {
      // A poll that read the board before this write must not land
      // after it and flip the look back: drop it, write, refetch.
      await queryClient.cancelQueries({ queryKey: key });
      queryClient.setQueryData<BoardClientView>(key, (current) =>
        current ? { ...current, board: { ...current.board, themeId: result.themeId ?? skin } } : current,
      );
      dispatch({ type: "applyDone", skin });
      clearTryOnParam();
    } else if (result.kind === "plusRequired") {
      dispatch({ type: "plusRequired", skin });
    } else {
      dispatch({ type: "applyFailed" });
    }
    void queryClient.invalidateQueries({ queryKey: key });
    return result.kind;
  }

  // The demo checkout: the host-only POST plus (PIN-103). A real
  // purchase goes through the credits route (useMakesFlow.buy).
  async function startCheckout(): Promise<CheckoutResult> {
    try {
      const response = await fetch(`/api/boards/${encodeURIComponent(slug)}/plus`, {
        ...JSON_REQUEST,
        method: "POST",
        body: JSON.stringify({ plan: "board" }),
      });
      return readCheckoutResponse(response.status, await readJson(response));
    } catch {
      return { kind: "failed" };
    }
  }

  async function getPlus(): Promise<MockGrantOutcome> {
    if (state.checkingOut || plusPurchasePath(plus?.mode) !== "mock") return "skipped";
    const skin = state.tryOn;
    dispatch({ type: "checkoutStart" });
    const result = await startCheckout();
    switch (result.kind) {
      case "granted":
        dispatch({ type: "checkoutGranted" });
        queryClient.setQueryData<BoardClientView>(key, (current) =>
          current
            ? { ...current, plus: result.plus ?? (current.plus ? { ...current.plus, active: true, plan: "board" } : current.plus) }
            : current,
        );
        if (skin) await applySkin(skin);
        else {
          dispatch({ type: "closeSheet" });
          void queryClient.invalidateQueries({ queryKey: key });
        }
        return "granted";
      case "unavailable":
        dispatch({ type: "checkoutUnavailable" });
        return "unavailable";
      case "redirect":
        // Stays busy while the browser leaves for checkout.
        window.location.href = result.url;
        return "redirect";
      case "failed":
        // The dock notice carries the error; the sheet must not stay up looking idle.
        dispatch({ type: "checkoutFailed" });
        return "failed";
    }
  }

  function pickLook(skin: SkinId) {
    const choice = chooseLook(skin, { boardSkin, tryOn, plus });
    switch (choice.kind) {
      case "none":
        dispatch({ type: "closeSheet" });
        return;
      case "restore":
        dispatch({ type: "endTryOn" });
        dispatch({ type: "closeSheet" });
        clearTryOnParam();
        return;
      case "apply":
        void applySkin(choice.skin);
        return;
      case "tryOn":
        dispatch({ type: "tryOn", skin: choice.skin });
        return;
    }
  }

  return {
    state,
    shownSkin,
    tryOn,
    openLook: () => dispatch({ type: "openLook" }),
    closeSheet: () => dispatch({ type: "closeSheet" }),
    pickLook,
    keep: () => {
      if (!tryOn || state.applying) return;
      if (keepStep(tryOn, plus) === "apply") void applySkin(tryOn);
      else dispatch({ type: "offerPlus" });
    },
    undo: () => {
      dispatch({ type: "endTryOn" });
      clearTryOnParam();
    },
    getPlus,
    dismissNotice: () => dispatch({ type: "dismissNotice" }),
  };
}

function noticeLine(locale: Locale, notice: LookNotice): string {
  switch (notice.kind) {
    case "applied":
      return tf(locale, "look.applied", { skin: skinName(notice.skin) });
    case "granted":
      return tf(locale, "plus.granted", { skin: skinName(notice.skin) });
    case "lookFailed":
      return t(locale, "look.failed");
    case "grantedLookFailed":
      return t(locale, "plus.grantedLookFailed");
    case "plusFailed":
      return t(locale, "plus.failed");
  }
}

/**
 * What the flow puts on screen: the Change look sheet, the TryOnBar
 * and one line above the dock (host only: the look flow gives no
 * try-on or notice to anyone else), and the one Plus sheet, which
 * everyone on the board can open (PIN-182). The sheet is open when
 * the creations indicator, a pool-empty button or the host's Keep it
 * asks for it, and buys by mode: the credits checkout in stripe, the
 * host-only demo grant in mock (with a note that it is a demo), and
 * nothing in off.
 */
export function PlusFlow({
  look,
  makes,
  boardSkin,
  plus,
  pack,
  isHost,
  sample,
  foilSrc,
  aboveDock,
  picking = false,
}: {
  look: LookFlow;
  makes: MakesFlow;
  boardSkin: SkinId;
  plus: PlusView | undefined;
  /** The one Policy pack (`credits.packs[0]`) the sheet sells; null when none is offered. */
  pack: (PlusPack & { lookupKey: string }) | null;
  isHost: boolean;
  sample: string[];
  /** A pinned cut-out to show the foil perk with. */
  foilSrc?: string;
  /** The dock is on screen: sit above it. */
  aboveDock: boolean;
  /** Picking things: the tray owns the thumb zone, so the try-on bar steps aside. */
  picking?: boolean;
}) {
  const locale = useLocale();
  const { state } = look;
  const notice = state.notice;
  const showBar = showTryOnBar(look.tryOn, state.applying, picking);
  const failed =
    notice?.kind === "lookFailed" || notice?.kind === "grantedLookFailed" || notice?.kind === "plusFailed";
  const path = plusPurchasePath(plus?.mode);
  const stripe = path === "stripe";
  const available = path !== "none" && !(stripe ? makes.unavailable : state.unavailable);
  // The demo grant adds no creations, so with Plus on its button cannot pretend;
  // before that it is the host's alone.
  const demoLockedLine =
    path !== "mock" ? null : plus?.active ? t(locale, "plus.demoNote") : isHost ? null : t(locale, "plus.hostOnly");
  const sheetOpen = state.sheet === "plus" || makes.sheetOpen;
  // One guard for both flows: neither close path alone knows about the
  // other's in-flight request.
  const closePlus = () => {
    if (plusSheetLocked(makes.busy, state.checkingOut)) return;
    if (state.sheet === "plus") look.closeSheet();
    makes.closeSheet();
  };
  const getPlus = () => {
    if (stripe && pack) makes.buy(pack.lookupKey, look.tryOn);
    else void look.getPlus().then((kind) => closesPlusSheetAfterMock(kind) && makes.closeSheet());
  };
  return (
    <>
      {notice || showBar ? (
        <div className={cx(styles.lookStack, aboveDock && styles.lookStackLifted)}>
          {notice ? (
            <div className={cx(styles.lookNotice, failed && styles.lookNoticeError)} role={failed ? "alert" : "status"}>
              <p>
                {noticeLine(locale, notice)}
                {notice.kind === "granted" && plus?.mode === "mock" ? <small>{t(locale, "plus.demoCharged")}</small> : null}
              </p>
              {failed ? (
                <IconButton icon="close" variant="ghost" size={18} label={t(locale, "ui.close")} onClick={look.dismissNotice} />
              ) : null}
            </div>
          ) : null}
          {showBar && look.tryOn ? <TryOnBar skin={look.tryOn} onUndo={look.undo} onKeep={look.keep} /> : null}
        </div>
      ) : null}

      {state.sheet === "look" ? (
        <ChangeLookSheet
          boardSkin={boardSkin}
          tryOn={look.tryOn}
          plus={plus}
          sample={sample}
          onPick={look.pickLook}
          onClose={look.closeSheet}
        />
      ) : null}

      {sheetOpen && plus ? (
        <>
          <PlusSheet
            pack={pack}
            plusActive={plus.active}
            available={available}
            lockedLine={demoLockedLine}
            paymentNote={stripe}
            busy={stripe ? makes.busy : state.checkingOut}
            error={stripe && makes.error ? checkoutErrorLine(makes.error, locale) : null}
            foilSrc={foilSrc}
            onGet={getPlus}
            onClose={closePlus}
          />
          {available && plus.mode === "mock" ? (
            <p className={styles.demoNote} role="note">
              {t(locale, "plus.demoNote")}
            </p>
          ) : null}
        </>
      ) : null}
    </>
  );
}
