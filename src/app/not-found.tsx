import { t } from "../i18n";
import { ButtonLink, Wordmark } from "../ui";
import { LibraryEmpty } from "./me/LibraryParts";

// Friendly dead end (PIN-43, restyled in PIN-104): a mistyped or
// expired link explains itself in one line and offers the one
// action that always works.
export default function NotFoundPage() {
  return (
    <main className="pn-skin-root pn-lib-page" data-theme="paper">
      <header className="pn-head">
        <div className="pn-head-row">
          <Wordmark size={22} href="/" />
        </div>
      </header>
      <LibraryEmpty title={t("en", "notFound.title")} body={t("en", "notFound.body")} headingLevel={1}>
        <ButtonLink variant="primary" size="lg" iconEnd="arrow" href="/">
          {t("en", "notFound.home")}
        </ButtonLink>
      </LibraryEmpty>
    </main>
  );
}
