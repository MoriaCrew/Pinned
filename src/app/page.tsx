import { t } from "../i18n";

// Landing. Board creation is live (PIN-66): Start goes to /new.
// The seeded demo board lands with PIN-55, so that action stays
// inert — no fake functionality.
export default function HomePage() {
  return (
    <main>
      <h1>{t("en", "landing.title")}</h1>
      <p className="tagline">{t("en", "landing.tagline")}</p>
      <p className="lede">{t("en", "landing.body")}</p>

      <div className="actions">
        <a className="btn btn-primary" href="/new">
          {t("en", "landing.start")}
        </a>
        <a className="btn" href="#soon" aria-disabled="true">
          {t("en", "landing.demo")}
        </a>
      </div>
      <p className="soon" id="soon">{t("en", "landing.soon")}</p>

      <h2>{t("en", "landing.howTitle")}</h2>
      <ol className="steps">
        <li>{t("en", "landing.step1")}</li>
        <li>{t("en", "landing.step2")}</li>
        <li>{t("en", "landing.step3")}</li>
      </ol>

      <footer>
        <a href="https://github.com/MoriaCrew/Pinned">{t("en", "footer.source")}</a>
      </footer>
    </main>
  );
}
