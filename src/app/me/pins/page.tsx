import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { getConfig } from "../../../config";
import { resolveAuthUi } from "../../../domain/auth-ui";
import { isValidSlug } from "../../../domain/tokens";
import { t, tCount, type Locale } from "../../../i18n";
import { getLocale } from "../../../i18n/server";
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
  const locale = await getLocale();
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
        <SignedOut locale={locale} enabled={ui.enabled} boardSlug={boardSlug} />
      ) : (
        <MyPinsList
          locale={locale}
          uid={user.uid}
          boardSlug={boardSlug}
          signInEnabled={ui.enabled}
        />
      )}
    </main>
  );
}

/** "Back to board" when the page was opened from a board's Add sheet. */
function backAction(locale: Locale, boardSlug: string | null) {
  return boardSlug ? (
    <ButtonLink variant="quiet" icon="back" href={`/g/${boardSlug}`}>
      {t(locale, "myPins.backToBoard")}
    </ButtonLink>
  ) : undefined;
}

function SignedOut({
  locale,
  enabled,
  boardSlug,
}: {
  locale: Locale;
  enabled: boolean;
  boardSlug: string | null;
}) {
  return (
    <>
      <LibraryHeader title={t(locale, "myPins.title")} action={backAction(locale, boardSlug)} offerSignIn={false} />
      {enabled ? (
        <LibraryEmpty title={t(locale, "myPins.signInPrompt")}>
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

async function MyPinsList({
  locale,
  uid,
  boardSlug,
  signInEnabled,
}: {
  locale: Locale;
  uid: string;
  boardSlug: string | null;
  signInEnabled: boolean;
}) {
  const users = getUserRepository();
  const profile = await users.getUser(uid);
  if (!profile) return <SignedOut locale={locale} enabled={signInEnabled} boardSlug={boardSlug} />;
  const page = await listMyElements(profile, {
    boards: getBoardRepository(),
    users,
    policy: getPolicy(),
  });
  const empty = page.elements.length === 0;
  return (
    <>
      <LibraryHeader
        title={t(locale, "myPins.title")}
        meta={empty ? undefined : tCount(locale, "meta.things", page.total)}
        action={backAction(locale, boardSlug)}
      />
      {empty ? (
        <LibraryEmpty title={t(locale, "myPins.empty")} body={t(locale, "myPins.emptyBody")}>
          {boardSlug ? (
            <ButtonLink variant="primary" size="lg" icon="back" href={`/g/${boardSlug}`}>
              {t(locale, "myPins.backToBoard")}
            </ButtonLink>
          ) : (
            <ButtonLink variant="primary" size="lg" icon="plus" href="/new">
              {t(locale, "myPins.emptyAction")}
            </ButtonLink>
          )}
        </LibraryEmpty>
      ) : (
        <PinLibrary locale={locale} cards={page.elements} boardSlug={boardSlug} />
      )}
    </>
  );
}
