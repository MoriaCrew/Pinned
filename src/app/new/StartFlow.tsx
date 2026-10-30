"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { createBoardPayload } from "../../domain/board-view";
import { newBoardHref, startChoice, suggestSkin, type SkinSuggestion } from "../../domain/skin-suggest";
import { DEFAULT_SKIN, SKINS, type SkinId } from "../../domain/skins";
import { t, tf, type MessageKey } from "../../i18n";
import { Button, Icon, Sheet, SkinPicker, TextField, Wordmark, skinName } from "../../ui";
import "./start-flow.css";

const NAME_FIELD_ID = "start-name";

/** Synthetic cut-outs the mini boards in the look picker wear (public/start/README.md). */
const SAMPLE = ["/start/cutout-rubber-duck.webp", "/start/cutout-red-sneakers.webp", "/start/cutout-straw-hat.webp"];

type Step = "name" | "look";

/**
 * Start a board (PIN-101, design system "StartFlow" steps 1 and 2).
 * 1. Name it: the only thing we ask.
 * 2. Pick a look: a sheet with the skin the title suggests already
 *    selected. Free skins are used as picked; a Plus skin starts the
 *    board on the best free skin and opens it as a try-on (the board
 *    offers it, PIN-103).
 * Step 3 (send the link) is the board itself.
 */
export function StartFlow({ titleMaxChars }: { titleMaxChars: number }) {
  const router = useRouter();
  const [step, setStep] = useState<Step>("name");
  const [title, setTitle] = useState("");
  const [nameError, setNameError] = useState("");
  const [cleanTitle, setCleanTitle] = useState("");
  const [suggestion, setSuggestion] = useState<SkinSuggestion>({ skin: DEFAULT_SKIN, reason: null });
  const [skin, setSkin] = useState<SkinId>(DEFAULT_SKIN);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const busyRef = useRef(false);
  const cameBack = useRef(false);

  // Focus the name field on arrival and when coming back from the sheet.
  useEffect(() => {
    if (step !== "name") return;
    const input = document.getElementById(NAME_FIELD_ID) as HTMLInputElement | null;
    if (!input) return;
    input.focus({ preventScroll: true });
    if (cameBack.current) {
      const end = input.value.length;
      input.setSelectionRange(end, end);
    }
  }, [step]);

  // The suggested look can sit in the last row of the picker: bring it into view.
  useEffect(() => {
    if (step !== "look") return;
    document
      .querySelector<HTMLInputElement>(".pn-start-picker input:checked")
      ?.closest(".pn-skin")
      ?.scrollIntoView({ block: "nearest" });
  }, [step]);

  function onNext(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = createBoardPayload(title, null, titleMaxChars);
    if (!result.ok) {
      setNameError(
        result.reason === "tooLong" ? t("en", "create.titleTooLong") : t("en", "create.titleRequired"),
      );
      return;
    }
    const next = suggestSkin(result.payload.title);
    setCleanTitle(result.payload.title);
    setSuggestion(next);
    setSkin(next.skin);
    setError("");
    setStep("look");
  }

  // Stable identity: Sheet re-focuses itself whenever onClose changes.
  const backToName = useCallback(() => {
    if (busyRef.current) return;
    cameBack.current = true;
    setError("");
    setStep("name");
  }, []);

  async function create() {
    if (busyRef.current) return;
    const { themeId, tryOn } = startChoice(skin, suggestion.skin);
    const result = createBoardPayload(cleanTitle, themeId, titleMaxChars);
    if (!result.ok) {
      setStep("name");
      setNameError(t("en", "create.titleRequired"));
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/boards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(result.payload),
      });
      const data = (await response.json().catch(() => ({}))) as {
        board?: { slug?: string };
        error?: unknown;
      };
      const slug = data.board?.slug;
      if (!response.ok || !slug) {
        throw new Error(typeof data.error === "string" && data.error ? data.error : t("en", "create.error"));
      }
      router.push(newBoardHref(slug, tryOn));
    } catch (cause) {
      // Server messages are one plain line; a dropped connection is not.
      const known = cause instanceof Error && !(cause instanceof TypeError);
      setError(known ? cause.message : t("en", "create.error"));
      busyRef.current = false;
      setBusy(false);
    }
  }

  const choice = startChoice(skin, suggestion.skin);
  const reason = suggestion.reason;
  const [fitsBefore, fitsAfter] = t("en", reason ? "create.fits" : "create.noSuggestion").split("{skin}");

  return (
    <>
      <div className="pn-start-pad" inert={step === "look"}>
        <Wordmark size={26} href="/" />
        {step === "name" ? (
          <form className="pn-start-form" onSubmit={onNext} noValidate>
            <h1 className="pn-board-title pn-start-title">{t("en", "create.title")}</h1>
            <TextField
              id={NAME_FIELD_ID}
              name="title"
              label={t("en", "create.nameLabel")}
              placeholder={t("en", "create.namePlaceholder")}
              help={t("en", "create.nameHelp")}
              maxLength={titleMaxChars}
              enterKeyHint="next"
              value={title}
              error={nameError || undefined}
              onChange={(value) => {
                setTitle(value);
                if (nameError) setNameError("");
              }}
            />
            <Button type="submit" variant="primary" size="lg" block iconEnd="arrow">
              {t("en", "create.next")}
            </Button>
          </form>
        ) : (
          <h1 className="pn-board-title pn-start-title">{cleanTitle}</h1>
        )}
      </div>

      {step === "look" ? (
        <Sheet
          className="pn-start-sheet"
          title={t("en", "create.lookTitle")}
          closeLabel={t("en", "create.back")}
          onClose={backToName}
          footer={
            <>
              {error ? (
                <p className="pn-start-error" role="alert">
                  <Icon name="info" size={16} />
                  {error}
                </p>
              ) : choice.tryOn ? (
                <p className="pn-start-note">{t("en", "create.plusNote")}</p>
              ) : null}
              <Button variant="primary" size="lg" block disabled={busy} onClick={create}>
                {busy
                  ? t("en", "create.creating")
                  : error
                    ? t("en", "create.retry")
                    : tf("en", "create.use", { skin: skinName(skin) })}
              </Button>
              <span className="pn-sr" role="status">
                {busy ? t("en", "create.creating") : ""}
              </span>
            </>
          }
        >
          <p className="pn-start-spark">
            <Icon name="skin" size={20} />
            <span>
              {reason ? `${t("en", `create.reason.${reason}` as MessageKey)} ` : null}
              {fitsBefore}
              <b>{skinName(suggestion.skin)}</b>
              {fitsAfter}
            </span>
          </p>
          <div className="pn-start-picker">
            <SkinPicker
              skins={SKINS.map((option) => ({
                id: option.id,
                suggested: reason !== null && option.id === suggestion.skin,
                locked: option.plus,
              }))}
              value={skin}
              onChange={(next) => {
                // A new pick is a fresh attempt: drop the old error so the
                // button names the new look and the Plus note can show.
                setSkin(next);
                setError("");
              }}
              sample={SAMPLE}
              legend={t("en", "ui.look")}
            />
          </div>
        </Sheet>
      ) : null}
    </>
  );
}
