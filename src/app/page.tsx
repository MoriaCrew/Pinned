import type { CSSProperties } from "react";
import { getConfig } from "../config";
import { BOARD_DELETED_PARAM, isBoardDeletedFlag } from "../domain/board-delete-ui";
import { anotherLandingSet, pickLandingSet } from "../domain/landing-sets";
import { t, tf, type Locale } from "../i18n";
import { getLocale } from "../i18n/server";
import { ButtonLink, Icon, Sticker, Tag, Wordmark, type IconName } from "../ui";
import { SiteLinks } from "./_legal/LegalParts";
import { You } from "./auth/You";
import { LANDING_SETS, landingSetById } from "./landing-sets.data";
import { BoardDeletedNotice } from "./me/BoardDeletedNotice";

// DEMO_BOARD_SLUG is a runtime env value (PIN-73) and the showcase set
// is drawn per request (PIN-175); render per request so neither needs
// a rebuild.
export const dynamic = "force-dynamic";

// Landing. Board creation is live (PIN-66): Start goes to /new.
// The demo action points at the seeded judge board only when
// DEMO_BOARD_SLUG is set (PIN-73, scripts/seed-demo-board.mjs);
// unset or invalid shows nothing: no fake functionality.
//
// The sticker pile and the three "How it works" pictures come from one
// showcase set (src/app/landing-sets.data.ts), a random one per visit;
// `?set=<id>` pins one, and "Show another" links to a different one.
// The art is synthetic (public/landing/README.md).
export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const locale = await getLocale();
  const demoSlug = getConfig().demoBoardSlug;
  const query = await searchParams;
  // PIN-168: the host lands here after deleting a board while signed out.
  const boardDeleted = isBoardDeletedFlag(query[BOARD_DELETED_PARAM]);
  const requested = query.set;
  const ids = LANDING_SETS.map((entry) => entry.id);
  const set = landingSetById(pickLandingSet(ids, { requested, random: Math.random }));
  const anotherHref = `/?set=${anotherLandingSet(ids, set.id, Math.random)}`;
  const { photo, scene } = set;
  return (
    <main className="pn-skin-root pn-lib-page pn-landing" data-theme="paper">
      <div className="pn-landing-inner">
        {/* Top right, over the hero (PIN-120); nothing at all when sign-in is off. */}
        <You className="pn-landing-you" />
        <div className="pn-landing-brand">
          <Wordmark size="clamp(72px, 9vw, 104px)" />
          <BoardDeletedNotice show={boardDeleted} />
        </div>

        {/* The pile drops in one sticker after another; its link sits right under it, outside the hidden art. */}
        <div className="pn-landing-show">
          <div className="pn-landing-pile" aria-hidden="true">
            {set.pile.map((slot, index) => (
              <Sticker
                key={slot.sticker}
                src={set.stickers[slot.sticker].src}
                seed={slot.sticker}
                tilt={slot.tilt}
                size={`${slot.size}%`}
                foil={slot.foil}
                state="arriving"
                loading="eager"
                style={
                  {
                    position: "absolute",
                    left: `${slot.left}%`,
                    top: `${slot.top}%`,
                    animationDelay: `${0.15 + index * 0.12}s`,
                  } as CSSProperties
                }
              />
            ))}
          </div>
          <ButtonLink
            variant="quiet"
            size="sm"
            icon="remix"
            href={anotherHref}
            aria-label={t(locale, "landing.anotherLabel")}
            className="pn-landing-another"
          >
            {t(locale, "landing.another")}
          </ButtonLink>
        </div>

        <div className="pn-landing-copy">
          <h1 className="pn-landing-promise">{t(locale, "landing.tagline")}</h1>
          <p className="pn-landing-body">{t(locale, "landing.body")}</p>
          <div className="pn-landing-actions">
            <ButtonLink variant="primary" size="lg" icon="plus" href="/new">
              {t(locale, "landing.start")}
            </ButtonLink>
            {demoSlug ? (
              <ButtonLink variant="secondary" size="lg" icon="scene" href={`/g/${demoSlug}`}>
                {t(locale, "landing.demo")}
              </ButtonLink>
            ) : null}
          </div>
          <p className="pn-landing-note">{t(locale, "landing.noSignup")}</p>
        </div>

        <section className="pn-landing-how" aria-labelledby="how-it-works">
          <h2 className="pn-section-title" id="how-it-works">
            {t(locale, "landing.howTitle")}
          </h2>
          <ol className="pn-landing-steps">
            <li className="pn-landing-step">
              <div className="pn-landing-art" aria-hidden="true">
                <span className="pn-print-wrap" style={{ "--t": -0.9 } as CSSProperties}>
                  <span className="pn-print">
                    <span className="pn-print-frame" style={{ aspectRatio: "1" }}>
                      <img
                        src={photo.src}
                        alt=""
                        loading="lazy"
                        style={{
                          objectPosition: photo.objectPosition,
                          scale: photo.scale?.toString(),
                          transformOrigin: photo.transformOrigin,
                        }}
                      />
                    </span>
                  </span>
                </span>
                {photo.chips.map((chip) => (
                  <span
                    key={chip.label}
                    className="pn-landing-chip"
                    style={{ left: `${chip.left}%`, top: `${chip.top}%`, rotate: `${chip.rotate ?? 0}deg` }}
                  >
                    <Tag tone="ink">{t(locale, chip.label)}</Tag>
                  </span>
                ))}
              </div>
              <StepText locale={locale} n={1} title={t(locale, "landing.step1")} body={t(locale, "landing.step1Body")} />
            </li>
            <li className="pn-landing-step">
              <div className="pn-landing-art pn-landing-art-stickers" aria-hidden="true">
                {set.trio.map((slot) => (
                  <Sticker
                    key={slot.sticker}
                    src={set.stickers[slot.sticker].src}
                    seed={`step-${slot.sticker}`}
                    tilt={slot.tilt}
                    size={`${slot.size}%`}
                    style={{ left: `${slot.left}%`, top: `${slot.top}%` }}
                  />
                ))}
              </div>
              <StepText locale={locale} n={2} title={t(locale, "landing.step2")} body={t(locale, "landing.step2Body")} />
            </li>
            <li className="pn-landing-step">
              <div className="pn-landing-art" aria-hidden="true">
                <span className="pn-print-wrap" style={{ "--t": 0.9 } as CSSProperties}>
                  <span className="pn-print">
                    <span className="pn-print-frame" style={{ aspectRatio: "1" }}>
                      <img src={scene.src} alt="" loading="lazy" style={{ objectPosition: scene.objectPosition }} />
                    </span>
                    <span className="pn-print-meta">
                      <span className="pn-print-no">{tf(locale, "ui.sceneNumber", { n: "01" })}</span>
                    </span>
                  </span>
                </span>
              </div>
              <StepText locale={locale} n={3} title={t(locale, "landing.step3")} body={t(locale, "landing.step3Body")} />
            </li>
          </ol>
        </section>

        <footer className="pn-landing-foot">
          {/* PIN-222: which Meta model does what, one quiet line each; PIN-237: the link opens /models. */}
          <section className="pn-landing-meta" aria-labelledby="made-with-meta">
            <h2 className="pn-landing-meta-title" id="made-with-meta">
              {t(locale, "landing.meta.title")}
            </h2>
            <ul className="pn-landing-meta-list">
              {metaLines(locale).map((line) => (
                <li key={line.icon}>
                  <Icon name={line.icon} size={18} />
                  {line.text}
                </li>
              ))}
            </ul>
          </section>
          <SiteLinks locale={locale}>
            <a href="/models">{t(locale, "landing.meta.more")}</a>
          </SiteLinks>
        </footer>
      </div>
    </main>
  );
}

/** One line per Meta model (PIN-222), each led by the icon of what it does. */
function metaLines(locale: Locale): { icon: IconName; text: string }[] {
  return [
    { icon: "pin", text: t(locale, "landing.meta.spark") },
    { icon: "cut", text: t(locale, "landing.meta.sam") },
    { icon: "scene", text: t(locale, "landing.meta.image") },
    { icon: "mic", text: t(locale, "landing.meta.voice") },
  ];
}

function StepText({ locale, n, title, body }: { locale: Locale; n: number; title: string; body: string }) {
  return (
    <div className="pn-landing-step-text">
      <span className="pn-landing-step-no">{tf(locale, "landing.stepNo", { n: String(n).padStart(2, "0") })}</span>
      <h3 className="pn-landing-step-title">{title}</h3>
      <p>{body}</p>
    </div>
  );
}
