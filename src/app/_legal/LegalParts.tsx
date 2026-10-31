import type { ReactNode } from "react";
import { DEFAULT_LOCALE, t, type Locale } from "../../i18n";
import { Wordmark } from "../../ui";

/**
 * Shared parts of /privacy and /terms (PIN-26). The `_legal` folder is
 * private (no route). The legal text is English only for now
 * (docs/18-i18n.md): the title, the footer links and a one-line
 * "English only" note follow the UI language, the body is static
 * English marked `lang="en"`. Every number in the body comes from
 * Policy at render time, never from a literal.
 */

export const SOURCE_URL = "https://github.com/MoriaCrew/Pinned";
export const ISSUES_URL = `${SOURCE_URL}/issues`;
/** Date shown under the title; change it whenever the text changes (history lives in git). */
export const LEGAL_UPDATED = "31 October 2026";

/** "1 day" / "30 days": the English body's own plural. */
export function plural(n: number, unit: string): string {
  return `${n} ${n === 1 ? unit : `${unit}s`}`;
}

/** Privacy, Terms and the source link: the landing footer and both legal pages. */
export function SiteLinks({ locale, current }: { locale: Locale; current?: "privacy" | "terms" }) {
  return (
    <nav className="pn-foot-links" aria-label={t(locale, "footer.label")}>
      <a href="/privacy" aria-current={current === "privacy" ? "page" : undefined}>
        {t(locale, "footer.privacy")}
      </a>
      <a href="/terms" aria-current={current === "terms" ? "page" : undefined}>
        {t(locale, "footer.terms")}
      </a>
      <a href={SOURCE_URL}>{t(locale, "footer.source")}</a>
    </nav>
  );
}

export function LegalShell({
  locale,
  title,
  current,
  children,
}: {
  locale: Locale;
  title: string;
  current: "privacy" | "terms";
  children: ReactNode;
}) {
  return (
    <main className="pn-skin-root pn-lib-page pn-legal" data-theme="paper">
      <header className="pn-head">
        <div className="pn-head-row">
          <Wordmark size={22} href="/" />
        </div>
      </header>
      <article className="pn-legal-doc" aria-labelledby="legal-title">
        <h1 id="legal-title" className="pn-legal-title">
          {title}
        </h1>
        {locale !== DEFAULT_LOCALE ? <p className="pn-legal-note">{t(locale, "legal.englishOnly")}</p> : null}
        <div className="pn-legal-body" lang="en">
          <p className="pn-legal-meta">Last updated {LEGAL_UPDATED}</p>
          {children}
        </div>
      </article>
      <footer className="pn-legal-foot">
        <SiteLinks locale={locale} current={current} />
      </footer>
    </main>
  );
}

export function LegalSection({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section className="pn-legal-section" aria-labelledby={id}>
      <h2 id={id} className="pn-legal-h2">
        {title}
      </h2>
      {children}
    </section>
  );
}

/**
 * Contact: the LEGAL_CONTACT_EMAIL address when the operator set one
 * (src/config.ts), else a public GitHub issue for non-private
 * questions. Never an invented address.
 */
export function ContactSection({ email }: { email: string | null }) {
  return (
    <LegalSection id="contact" title="Contact">
      {email ? (
        <p>
          Questions, requests about your data, or a refund: email <a href={`mailto:${email}`}>{email}</a>.
        </p>
      ) : (
        <p>
          Questions: <a href={ISSUES_URL}>open an issue on GitHub</a>. Issues are public, so don&apos;t post
          personal details, board links or payment details there.
        </p>
      )}
    </LegalSection>
  );
}
