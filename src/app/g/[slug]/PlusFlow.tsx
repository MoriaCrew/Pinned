"use client";

import { useEffect, useReducer, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { PlusPlan, PlusView } from "../../../domain/plus";
import {
  activeTryOn,
  canBuyPlus,
  chooseLook,
  effectiveSkin,
  initialLookFlow,
  keepStep,
  lookFlow,
  parseTryOn,
  readCheckoutResponse,
  readSkinResponse,
  urlWithoutTryOn,
  type CheckoutResult,
  type LookFlowState,
  type LookNotice,
  type SkinResult,
} from "../../../domain/plus-ui";
import type { SkinId } from "../../../domain/skins";
import { t, tf } from "../../../i18n";
import { IconButton, PlusSheet, TryOnBar, cx, skinName } from "../../../ui";
import { boardQueryKey } from "./AddSheet";
import type { BoardClientView } from "./BoardClient";
import { ChangeLookSheet } from "./ChangeLookSheet";
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
  choosePlan: (plan: PlusPlan) => void;
  getPlus: (plan: PlusPlan) => void;
  dismissNotice: () => void;
}

/**
 * Board Plus on the board (PIN-111, docs/15): the host's Change
 * look, the local Plus try-on and Keep it. The server decides
 * (host cookie, entitlement, PLUS_MODE); this keeps the screen
 * honest about it: a free look shows at once and reverts on error,
 * a try-on is local until kept, Keep it asks for Plus only when
 * the board lacks it, and billing "off" never sells anything.
 */
export function useLookFlow({
  slug,
  boardSkin,
  isHost,
  plus,
  tryOnParam,
}: {
  slug: string;
  boardSkin: SkinId;
  isHost: boolean;
  plus: PlusView | undefined;
  /** `?tryon=` from the link (validated again here). */
  tryOnParam: unknown;
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

  async function applySkin(skin: SkinId) {
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
  }

  async function startCheckout(plan: PlusPlan): Promise<CheckoutResult> {
    try {
      const response = await fetch(`/api/boards/${encodeURIComponent(slug)}/plus`, {
        ...JSON_REQUEST,
        method: "POST",
        body: JSON.stringify({ plan }),
      });
      return readCheckoutResponse(response.status, await readJson(response));
    } catch {
      return { kind: "failed" };
    }
  }

  async function getPlus(plan: PlusPlan) {
    if (state.checkingOut || !canBuyPlus(plus)) return;
    const skin = state.tryOn;
    dispatch({ type: "checkoutStart" });
    const result = await startCheckout(plan);
    switch (result.kind) {
      case "granted":
        dispatch({ type: "checkoutGranted" });
        queryClient.setQueryData<BoardClientView>(key, (current) =>
          current
            ? { ...current, plus: result.plus ?? (current.plus ? { ...current.plus, active: true, plan } : current.plus) }
            : current,
        );
        if (skin) await applySkin(skin);
        else {
          dispatch({ type: "closeSheet" });
          void queryClient.invalidateQueries({ queryKey: key });
        }
        return;
      case "unavailable":
        dispatch({ type: "checkoutUnavailable" });
        return;
      case "redirect":
        // Stays busy while the browser leaves for checkout.
        window.location.href = result.url;
        return;
      case "failed":
        dispatch({ type: "checkoutFailed" });
        return;
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
    choosePlan: (plan) => dispatch({ type: "choosePlan", plan }),
    getPlus: (plan) => void getPlus(plan),
    dismissNotice: () => dispatch({ type: "dismissNotice" }),
  };
}

function noticeLine(notice: LookNotice): string {
  switch (notice.kind) {
    case "applied":
      return tf("en", "look.applied", { skin: skinName(notice.skin) });
    case "granted":
      return tf("en", "plus.granted", { skin: skinName(notice.skin) });
    case "lookFailed":
      return t("en", "look.failed");
    case "grantedLookFailed":
      return t("en", "plus.grantedLookFailed");
    case "plusFailed":
      return t("en", "plus.failed");
  }
}

/**
 * What the flow puts on screen (host only): the Change look and
 * Plus sheets, the TryOnBar and one line above the dock, and, while
 * the mock checkout is open, a note that it is a demo.
 */
export function PlusFlow({
  look,
  boardSkin,
  plus,
  sample,
  foilSrc,
  aboveDock,
}: {
  look: LookFlow;
  boardSkin: SkinId;
  plus: PlusView | undefined;
  sample: string[];
  /** A pinned cut-out to show the foil perk with. */
  foilSrc?: string;
  /** The dock is on screen: sit above it. */
  aboveDock: boolean;
}) {
  const { state } = look;
  const notice = state.notice;
  const showBar = look.tryOn !== null && state.applying === null;
  const failed =
    notice?.kind === "lookFailed" || notice?.kind === "grantedLookFailed" || notice?.kind === "plusFailed";
  const available = canBuyPlus(plus) && !state.unavailable;
  return (
    <>
      {notice || showBar ? (
        <div className={cx(styles.lookStack, aboveDock && styles.lookStackLifted)}>
          {notice ? (
            <div className={cx(styles.lookNotice, failed && styles.lookNoticeError)} role={failed ? "alert" : "status"}>
              <p>
                {noticeLine(notice)}
                {notice.kind === "granted" && plus?.mode === "mock" ? <small>{t("en", "plus.demoCharged")}</small> : null}
              </p>
              {failed ? (
                <IconButton icon="close" variant="ghost" size={18} label={t("en", "ui.close")} onClick={look.dismissNotice} />
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

      {state.sheet === "plus" && plus ? (
        <>
          <PlusSheet
            plan={state.plan}
            onPlanChange={look.choosePlan}
            prices={plus.priceLabels}
            available={available}
            busy={state.checkingOut}
            foilSrc={foilSrc}
            onGet={look.getPlus}
            onClose={look.closeSheet}
          />
          {available && plus.mode === "mock" ? (
            <p className={styles.demoNote} role="note">
              {t("en", "plus.demoNote")}
            </p>
          ) : null}
        </>
      ) : null}
    </>
  );
}
