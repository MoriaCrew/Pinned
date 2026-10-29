import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { getConfig } from "../../../config";
import { resolveAuthUi } from "../../../domain/auth-ui";
import { isValidSlug } from "../../../domain/tokens";
import { t } from "../../../i18n";
import { getPolicy } from "../../../policy/server";
import { getBoardRepository } from "../../../server/board-repository";
import { listMyElements } from "../../../server/my-pins";
import { getUserRepository } from "../../../server/user-repository";
import {
  resolveUserSession,
  USER_COOKIE_NAME,
} from "../../../server/user-session";
import { PinToBoardButton } from "./PinToBoardButton";

export const dynamic = "force-dynamic";

/**
 * My pins (PIN-85): every element this signed-in user owns on
 * any claimed board, newest first, each labelled with its
 * source board's TITLE (never its slug). Opened with
 * ?board=<slug> (from a board's Add sheet) each card gains a
 * Pin-to-this-board button. The route does not exist in
 * link-only mode (uniform 404, like the auth API routes).
 */
export default async function MyPinsPage({
  searchParams,
}: {
  searchParams: Promise<{ board?: string }>;
}) {
  const cfg = getConfig();
  if (cfg.authMode !== "optional") notFound();
  const ui = resolveAuthUi({
    authMode: cfg.authMode,
    apiKey: cfg.firebaseWebApiKey,
    authDomain: cfg.firebaseWebAuthDomain,
    projectId: cfg.firebaseProjectId,
  });
  const { board } = await searchParams;
  const boardSlug = board !== undefined && isValidSlug(board) ? board : null;
  const cookieStore = await cookies();
  const user = await resolveUserSession(
    cookieStore.get(USER_COOKIE_NAME)?.value ?? null,
    {
      users: getUserRepository(),
      sessionSecret: cfg.sessionSecret,
      policy: getPolicy(),
    },
  ).catch(() => null);

  return (
    <main className="board-main">
      <p className="eyebrow">
        <a href="/">📌 Pinneds</a>
      </p>
      <h1>{t("en", "myPins.title")}</h1>
      {!user ? (
        <p className="lede">
          {ui.enabled
            ? t("en", "myPins.signInPrompt")
            : t("en", "auth.notConfigured")}
        </p>
      ) : (
        <MyPinsList uid={user.uid} boardSlug={boardSlug} />
      )}
    </main>
  );
}

async function MyPinsList({
  uid,
  boardSlug,
}: {
  uid: string;
  boardSlug: string | null;
}) {
  const users = getUserRepository();
  const profile = await users.getUser(uid);
  if (!profile) return <p className="lede">{t("en", "myPins.signInPrompt")}</p>;
  const page = await listMyElements(profile, {
    boards: getBoardRepository(),
    users,
    policy: getPolicy(),
  });
  if (page.elements.length === 0) {
    return <p className="lede">{t("en", "myPins.empty")}</p>;
  }
  return (
    <>
      {boardSlug ? (
        <p className="lede">
          <a href={`/g/${boardSlug}`}>← {t("en", "myPins.backToBoard")}</a>
        </p>
      ) : null}
      <ul className="pins-grid">
        {page.elements.map((card) => (
          <li key={card.elementId} className="pin-card">
            {/* eslint-disable-next-line @next/next/no-img-element -- owner-checked API image */}
            <img src={card.imageUrl} alt={card.label} loading="lazy" />
            <p className="pin-label">{card.label}</p>
            <p className="my-pin-source">
              {t("en", "myPins.fromBoard")} {card.sourceBoardTitle}
            </p>
            {boardSlug ? (
              <PinToBoardButton slug={boardSlug} elementId={card.elementId} />
            ) : null}
          </li>
        ))}
      </ul>
    </>
  );
}
