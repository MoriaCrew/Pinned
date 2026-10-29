import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { getConfig } from "../../../config";
import { resolveAuthUi } from "../../../domain/auth-ui";
import { t } from "../../../i18n";
import { getPolicy } from "../../../policy/server";
import { getBoardRepository } from "../../../server/board-repository";
import { listMyBoards } from "../../../server/my-boards";
import { getUserRepository } from "../../../server/user-repository";
import {
  resolveUserSession,
  USER_COOKIE_NAME,
} from "../../../server/user-session";

export const dynamic = "force-dynamic";

/**
 * My boards (PIN-84): every board this signed-in user has
 * claimed, newest activity first. The route does not exist in
 * link-only mode (uniform 404, like the auth API routes).
 * Signed-out visitors in optional mode get an honest prompt —
 * the header sign-in button is right there when configured.
 */
export default async function MyBoardsPage() {
  const cfg = getConfig();
  if (cfg.authMode !== "optional") notFound();
  const ui = resolveAuthUi({
    authMode: cfg.authMode,
    apiKey: cfg.firebaseWebApiKey,
    authDomain: cfg.firebaseWebAuthDomain,
    projectId: cfg.firebaseProjectId,
  });
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
      <h1>{t("en", "myBoards.title")}</h1>
      {!user ? (
        <p className="lede">
          {ui.enabled
            ? t("en", "myBoards.signInPrompt")
            : t("en", "auth.notConfigured")}
        </p>
      ) : (
        <MyBoardsList uid={user.uid} />
      )}
    </main>
  );
}

async function MyBoardsList({ uid }: { uid: string }) {
  const users = getUserRepository();
  const profile = await users.getUser(uid);
  if (!profile) return <p className="lede">{t("en", "myBoards.signInPrompt")}</p>;
  const boards = await listMyBoards(profile, {
    boards: getBoardRepository(),
    users,
  });
  if (boards.length === 0) {
    return <p className="lede">{t("en", "myBoards.empty")}</p>;
  }
  return (
    <ul className="my-boards">
      {boards.map((board) => (
        <li key={board.slug} className="card my-board-card">
          <a href={`/g/${board.slug}`}>
            {board.latestSceneImageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- board-link-checked image route
              <img
                className="my-board-thumb"
                src={board.latestSceneImageUrl}
                alt=""
                width={512}
                height={512}
              />
            ) : null}
            <span className="my-board-title">{board.title}</span>
            {board.themeLabel ? (
              <span className="fact-chip">
                {board.themeMotif} {board.themeLabel}
              </span>
            ) : null}
            <span className="my-board-meta">
              📌 {board.myPinCount} {t("en", "myBoards.myPins")} ·{" "}
              {t("en", "myBoards.lastActive")}{" "}
              {new Date(board.lastActivityAt).toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
              })}
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}
