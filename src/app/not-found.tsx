import { t } from "../i18n";

// Friendly dead end (PIN-43): a mistyped or expired link explains
// itself and offers the one action that always works.
export default function NotFoundPage() {
  return (
    <main>
      <h1>{t("en", "notFound.title")}</h1>
      <p className="lede">{t("en", "notFound.body")}</p>
      <div className="actions">
        <a className="btn btn-primary" href="/">{t("en", "notFound.home")}</a>
      </div>
    </main>
  );
}
