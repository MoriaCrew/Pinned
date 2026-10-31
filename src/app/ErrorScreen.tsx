"use client";

import type { CSSProperties } from "react";
import { t, type Locale } from "../i18n";
import { Button, ButtonLink, Wordmark } from "../ui";

/**
 * The page a visitor sees when something throws (PIN-212): the same
 * quiet Paper dead end as not-found (PIN-104), one line that owns the
 * mistake, a retry and a way out. Shared by `error.tsx` (inside the
 * root layout) and `global-error.tsx` (the root layout itself failed,
 * so no provider is around: `locale` comes in as a prop).
 *
 * Never shows the error, its message or its digest: those can carry
 * server detail, and they are in the server log already.
 */
export function ErrorScreen({ locale, onRetry }: { locale: Locale; onRetry: () => void }) {
  return (
    <main className="pn-skin-root pn-lib-page" data-theme="paper">
      <header className="pn-head">
        <div className="pn-head-row">
          <Wordmark size={22} />
        </div>
      </header>
      <section className="pn-empty pn-lib-empty" role="alert">
        <div className="pn-empty-ghosts" aria-hidden="true">
          <span className="pn-ghost" style={{ "--t": -0.8 } as CSSProperties} />
          <span className="pn-ghost pn-ghost-tall" style={{ "--t": 0.6 } as CSSProperties} />
          <span className="pn-ghost pn-ghost-wide" style={{ "--t": -0.3 } as CSSProperties} />
        </div>
        <h1 className="pn-section-title">{t(locale, "error.pageTitle")}</h1>
        <p className="pn-empty-body">{t(locale, "error.pageBody")}</p>
        <div className="pn-empty-actions">
          <Button variant="primary" size="lg" icon="undo" onClick={onRetry}>
            {t(locale, "error.pageRetry")}
          </Button>
          <ButtonLink variant="secondary" size="lg" href="/">
            {t(locale, "error.pageHome")}
          </ButtonLink>
        </div>
      </section>
    </main>
  );
}
