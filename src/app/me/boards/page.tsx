import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { getConfig } from "../../../config";
import { resolveAuthUi } from "../../../domain/auth-ui";
import { BOARD_DELETED_PARAM, isBoardDeletedFlag } from "../../../domain/board-delete-ui";
import { t, tCount, type Locale } from "../../../i18n";
import { getLocale } from "../../../i18n/server";
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
import { BoardDeletedNotice } from "../BoardDeletedNotice";
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
export default async function MyBoardsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const locale = await getLocale();
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
        <SignedOut locale={locale} enabled={ui.enabled} />
      ) : (
        <MyBoardsList
          locale={locale}
          uid={user.uid}
          signInEnabled={ui.enabled}
          boardDeleted={isBoardDeletedFlag((await searchParams)[BOARD_DELETED_PARAM])}
        />
      )}
    </main>
  );
}

function SignedOut({ locale, enabled }: { locale: Locale; enabled: boolean }) {
  return (
    <>
      <LibraryHeader title={t(locale, "myBoards.title")} offerSignIn={false} />
      {enabled ? (
        <LibraryEmpty title={t(locale, "myBoards.signInPrompt")}>
          <SignInButton variant="primary" size="lg" stacked />
        </LibraryEmpty>
      ) : (
        <LibraryEmpty title={t(locale, "auth.notConfigured")}>
          <ButtonLink variant="secondary" size="lg" href="/">
            {t(locale, "notFound.home")}
          </ButtonLink>
        </LibraryEmpty>
      )}
    </>
  );
}

async function MyBoardsList({
  locale,
  uid,
  signInEnabled,
  boardDeleted,
}: {
  locale: Locale;
  uid: string;
  signInEnabled: boolean;
  /** PIN-168: `?deleted=1`, the host just deleted a board. */
  boardDeleted: boolean;
}) {
  const users = getUserRepository();
  const profile = await users.getUser(uid);
  if (!profile) return <SignedOut locale={locale} enabled={signInEnabled} />;
  const boards = await listMyBoards(profile, {
    boards: getBoardRepository(),
    users,
    plusMode: getConfig().plusMode,
  });
  return (
    <>
      <LibraryHeader
        title={t(locale, "myBoards.title")}
        meta={boards.length > 0 ? tCount(locale, "myBoards.count", boards.length) : undefined}
      />
      <BoardDeletedNotice show={boardDeleted} />
      {boards.length === 0 ? (
        <LibraryEmpty title={t(locale, "myBoards.empty")} body={t(locale, "myBoards.emptyBody")}>
          <ButtonLink variant="primary" size="lg" icon="plus" href="/new">
            {t(locale, "myBoards.emptyAction")}
          </ButtonLink>
        </LibraryEmpty>
      ) : (
        <BoardCards locale={locale} boards={boards} />
      )}
    </>
  );
}
