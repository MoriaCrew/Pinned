"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { createBoardPayload } from "../../domain/board-view";
import { newBoardHref, startChoice, suggestSkin, type SkinSuggestion } from "../../domain/skin-suggest";
import { DEFAULT_SKIN, type SkinId } from "../../domain/skins";
import { t } from "../../i18n";
import { useLocale } from "../../i18n/client";
import { Button, TextField, Wordmark } from "../../ui";
import { StartLookSheet } from "./StartLookSheet";
import "./start-flow.css";

const NAME_FIELD_ID = "start-name";

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
  const locale = useLocale();
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
        result.reason === "tooLong" ? t(locale, "create.titleTooLong") : t(locale, "create.titleRequired"),
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
      setNameError(t(locale, "create.titleRequired"));
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
        throw new Error(typeof data.error === "string" && data.error ? data.error : t(locale, "create.error"));
      }
      router.push(newBoardHref(slug, tryOn));
    } catch (cause) {
      // Server messages are one plain line; a dropped connection is not.
      const known = cause instanceof Error && !(cause instanceof TypeError);
      setError(known ? cause.message : t(locale, "create.error"));
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <>
      <div className="pn-start-pad" inert={step === "look"}>
        <Wordmark size={26} href="/" />
        {step === "name" ? (
          <form className="pn-start-form" onSubmit={onNext} noValidate>
            <h1 className="pn-board-title pn-start-title">{t(locale, "create.title")}</h1>
            <TextField
              id={NAME_FIELD_ID}
              name="title"
              label={t(locale, "create.nameLabel")}
              placeholder={t(locale, "create.namePlaceholder")}
              help={t(locale, "create.nameHelp")}
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
              {t(locale, "create.next")}
            </Button>
          </form>
        ) : (
          <h1 className="pn-board-title pn-start-title">{cleanTitle}</h1>
        )}
      </div>

      {step === "look" ? (
        <StartLookSheet
          suggestion={suggestion}
          skin={skin}
          busy={busy}
          error={error}
          onPick={(next) => {
            // A new pick is a fresh attempt: drop the old error so the
            // button names the new look and the Plus note can show.
            setSkin(next);
            setError("");
          }}
          onCreate={create}
          onClose={backToName}
        />
      ) : null}
    </>
  );
}
