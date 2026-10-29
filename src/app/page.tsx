import { getConfig } from "../config";
import { t } from "../i18n";

// DEMO_BOARD_SLUG is a runtime env value (PIN-73); render per
// request so setting it needs no rebuild.
export const dynamic = "force-dynamic";

// Landing. Board creation is live (PIN-66): Start goes to /new.
// The demo action points at the seeded judge board only when
// DEMO_BOARD_SLUG is set (PIN-73, scripts/seed-demo-board.mjs);
// unset or invalid keeps it inert — no fake functionality.
export default function HomePage() {
  const demoSlug = getConfig().demoBoardSlug;
  return (
    <main>
      <h1>{t("en", "landing.title")}</h1>
      <p className="tagline">{t("en", "landing.tagline")}</p>
      <p className="lede">{t("en", "landing.body")}</p>

      <div className="actions">
        <a className="btn btn-primary" href="/new">
          {t("en", "landing.start")}
        </a>
        {demoSlug ? (
          <a className="btn" href={`/g/${demoSlug}`}>
            {t("en", "landing.demo")}
          </a>
        ) : (
          <a className="btn" href="#soon" aria-disabled="true">
            {t("en", "landing.demo")}
          </a>
        )}
      </div>
      {!demoSlug && (
        <p className="soon" id="soon">{t("en", "landing.soon")}</p>
      )}

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
