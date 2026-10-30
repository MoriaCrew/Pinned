import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { getConfig } from "../../../config";
import { resolveAuthUi } from "../../../domain/auth-ui";
import { isValidSlug } from "../../../domain/tokens";
import { t, tCount } from "../../../i18n";
import { getPolicy } from "../../../policy/server";
import { getBoardRepository } from "../../../server/board-repository";
import { listMyElements } from "../../../server/my-pins";
import { getUserRepository } from "../../../server/user-repository";
import {
  resolveUserSession,
  USER_COOKIE_NAME,
} from "../../../server/user-session";
import { ButtonLink } from "../../../ui";
import { SignInButton } from "../../auth/SignInButton";
import { LibraryEmpty, LibraryHeader, PinLibrary } from "../LibraryParts";

export const dynamic = "force-dynamic";

/**
 * My pins (PIN-85): every element this signed-in user owns on
 * any claimed board, newest first, each labelled with its
 * source board's TITLE (never its slug). Opened with
 * ?board=<slug> (from a board's Add sheet) each card gains a
 * Pin-here button. The route does not exist in link-only mode
 * (uniform 404, like the auth API routes). PIN-104: restyled as
 * a sticker library on the design system.
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
    <main className="pn-skin-root pn-lib-page" data-theme="paper">
      {!user ? (
        <SignedOut enabled={ui.enabled} boardSlug={boardSlug} />
      ) : (
        <MyPinsList
          uid={user.uid}
          boardSlug={boardSlug}
          signInEnabled={ui.enabled}
        />
      )}
    </main>
  );
}

/** "Back to board" when the page was opened from a board's Add sheet. */
function backAction(boardSlug: string | null) {
  return boardSlug ? (
    <ButtonLink variant="quiet" icon="back" href={`/g/${boardSlug}`}>
      {t("en", "myPins.backToBoard")}
    </ButtonLink>
  ) : undefined;
}

function SignedOut({
  enabled,
  boardSlug,
}: {
  enabled: boolean;
  boardSlug: string | null;
}) {
  return (
    <>
      <LibraryHeader title={t("en", "myPins.title")} action={backAction(boardSlug)} offerSignIn={false} />
      {enabled ? (
        <LibraryEmpty title={t("en", "myPins.signInPrompt")}>
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

async function MyPinsList({
  uid,
  boardSlug,
  signInEnabled,
}: {
  uid: string;
  boardSlug: string | null;
  signInEnabled: boolean;
}) {
  const users = getUserRepository();
  const profile = await users.getUser(uid);
  if (!profile) return <SignedOut enabled={signInEnabled} boardSlug={boardSlug} />;
  const page = await listMyElements(profile, {
    boards: getBoardRepository(),
    users,
    policy: getPolicy(),
  });
  const empty = page.elements.length === 0;
  return (
    <>
      <LibraryHeader
        title={t("en", "myPins.title")}
        meta={empty ? undefined : tCount("en", "meta.things", page.total)}
        action={backAction(boardSlug)}
      />
      {empty ? (
        <LibraryEmpty title={t("en", "myPins.empty")} body={t("en", "myPins.emptyBody")}>
          {boardSlug ? (
            <ButtonLink variant="primary" size="lg" icon="back" href={`/g/${boardSlug}`}>
              {t("en", "myPins.backToBoard")}
            </ButtonLink>
          ) : (
            <ButtonLink variant="primary" size="lg" icon="plus" href="/new">
              {t("en", "myPins.emptyAction")}
            </ButtonLink>
          )}
        </LibraryEmpty>
      ) : (
        <PinLibrary cards={page.elements} boardSlug={boardSlug} />
      )}
    </>
  );
}
