import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { getConfig } from "../../../config";
import { resolveAuthUi } from "../../../domain/auth-ui";
import { t, tCount } from "../../../i18n";
import { getPolicy } from "../../../policy/server";
import { getBoardRepository } from "../../../server/board-repository";
import { listMyBoards } from "../../../server/my-boards";
import { getUserRepository } from "../../../server/user-repository";
import {
  resolveUserSession,
  USER_COOKIE_NAME,
} from "../../../server/user-session";
import { ButtonLink } from "../../../ui";
import { SignInButton } from "../../auth/SignInButton";
import { BoardCards, LibraryEmpty, LibraryHeader } from "../LibraryParts";

export const dynamic = "force-dynamic";

/**
 * My boards (PIN-84): every board this signed-in user has
 * claimed, newest activity first. The route does not exist in
 * link-only mode (uniform 404, like the auth API routes).
 * Signed-out visitors in optional mode get one line and a Sign in
 * button (or an honest "not set up" line when sign-in is not
 * configured). PIN-104: restyled on the design system; each board
 * is a mini board in its own skin.
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
    <main className="pn-skin-root pn-lib-page" data-theme="paper">
      {!user ? (
        <SignedOut enabled={ui.enabled} />
      ) : (
        <MyBoardsList uid={user.uid} signInEnabled={ui.enabled} />
      )}
    </main>
  );
}

function SignedOut({ enabled }: { enabled: boolean }) {
  return (
    <>
      <LibraryHeader title={t("en", "myBoards.title")} />
      {enabled ? (
        <LibraryEmpty title={t("en", "myBoards.signInPrompt")}>
          <SignInButton variant="primary" size="lg" stacked />
        </LibraryEmpty>
      ) : (
        <LibraryEmpty title={t("en", "auth.notConfigured")}>
          <ButtonLink variant="secondary" size="lg" href="/">
            {t("en", "notFound.home")}
          </ButtonLink>
        </LibraryEmpty>
      )}
    </>
  );
}

async function MyBoardsList({
  uid,
  signInEnabled,
}: {
  uid: string;
  signInEnabled: boolean;
}) {
  const users = getUserRepository();
  const profile = await users.getUser(uid);
  if (!profile) return <SignedOut enabled={signInEnabled} />;
  const boards = await listMyBoards(profile, {
    boards: getBoardRepository(),
    users,
  });
  return (
    <>
      <LibraryHeader
        title={t("en", "myBoards.title")}
        meta={boards.length > 0 ? tCount("en", "myBoards.count", boards.length) : undefined}
      />
      {boards.length === 0 ? (
        <LibraryEmpty title={t("en", "myBoards.empty")} body={t("en", "myBoards.emptyBody")}>
          <ButtonLink variant="primary" size="lg" icon="plus" href="/new">
            {t("en", "myBoards.emptyAction")}
          </ButtonLink>
        </LibraryEmpty>
      ) : (
        <BoardCards boards={boards} />
      )}
    </>
  );
}
