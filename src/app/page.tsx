import type { CSSProperties } from "react";
import { getConfig } from "../config";
import { BOARD_DELETED_PARAM, isBoardDeletedFlag } from "../domain/board-delete-ui";
import { t, tf } from "../i18n";
import { ButtonLink, Sticker, Tag, Wordmark } from "../ui";
import { You } from "./auth/You";
import { BoardDeletedNotice } from "./me/BoardDeletedNotice";

// DEMO_BOARD_SLUG is a runtime env value (PIN-73); render per
// request so setting it needs no rebuild.
export const dynamic = "force-dynamic";

const IMG = "/landing";

/**
 * The hero pile: six die-cut stickers, tilted and overlapping a
 * little, dropped in one after another. Positions are percentages
 * of the pile's box; the duck is the foil one. Synthetic images
 * (public/landing/README.md).
 */
const PILE: {
  id: string;
  left: number;
  top: number;
  size: number;
  tilt: number;
  foil?: boolean;
}[] = [
  { id: "red-alarm-clock", left: 0, top: 12, size: 40, tilt: -0.85 },
  { id: "teal-mug", left: 31, top: -2, size: 44, tilt: 0.55 },
  { id: "orange-tabby-cat", left: 51, top: 25, size: 46, tilt: 0.7 },
  { id: "straw-hat", left: 3, top: 48, size: 38, tilt: -0.45 },
  { id: "red-sneakers", left: 26, top: 58, size: 48, tilt: 0.9 },
  { id: "rubber-duck", left: 30, top: 30, size: 28, tilt: -0.6, foil: true },
];

// Landing. Board creation is live (PIN-66): Start goes to /new.
// The demo action points at the seeded judge board only when
// DEMO_BOARD_SLUG is set (PIN-73, scripts/seed-demo-board.mjs);
// unset or invalid shows nothing: no fake functionality.
export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const demoSlug = getConfig().demoBoardSlug;
  // PIN-168: the host lands here after deleting a board while signed out.
  const boardDeleted = isBoardDeletedFlag((await searchParams)[BOARD_DELETED_PARAM]);
  return (
    <main className="pn-skin-root pn-lib-page pn-landing" data-theme="paper">
      <div className="pn-landing-inner">
        {/* Top right, over the hero (PIN-120); nothing at all when sign-in is off. */}
        <You className="pn-landing-you" />
        <div className="pn-landing-brand">
          <Wordmark size="clamp(72px, 9vw, 104px)" />
          <BoardDeletedNotice show={boardDeleted} />
        </div>

        <div className="pn-landing-pile" aria-hidden="true">
          {PILE.map((item, index) => (
            <Sticker
              key={item.id}
              src={`${IMG}/cutout-${item.id}.webp`}
              seed={item.id}
              tilt={item.tilt}
              size={`${item.size}%`}
              foil={item.foil}
              state="arriving"
              loading="eager"
              style={
                {
                  position: "absolute",
                  left: `${item.left}%`,
                  top: `${item.top}%`,
                  animationDelay: `${0.15 + index * 0.12}s`,
                } as CSSProperties
              }
            />
          ))}
        </div>

        <div className="pn-landing-copy">
          <h1 className="pn-landing-promise">{t("en", "landing.tagline")}</h1>
          <p className="pn-landing-body">{t("en", "landing.body")}</p>
          <div className="pn-landing-actions">
            <ButtonLink variant="primary" size="lg" icon="plus" href="/new">
              {t("en", "landing.start")}
            </ButtonLink>
            {demoSlug ? (
              <ButtonLink variant="secondary" size="lg" icon="scene" href={`/g/${demoSlug}`}>
                {t("en", "landing.demo")}
              </ButtonLink>
            ) : null}
          </div>
          <p className="pn-landing-note">{t("en", "landing.noSignup")}</p>
        </div>

        <section className="pn-landing-how" aria-labelledby="how-it-works">
          <h2 className="pn-section-title" id="how-it-works">
            {t("en", "landing.howTitle")}
          </h2>
          <ol className="pn-landing-steps">
            <li className="pn-landing-step">
              <div className="pn-landing-art" aria-hidden="true">
                <span className="pn-print-wrap" style={{ "--t": -0.9 } as CSSProperties}>
                  <span className="pn-print">
                    <span className="pn-print-frame" style={{ aspectRatio: "1" }}>
                      {/* eslint-disable-next-line @next/next/no-img-element -- synthetic landing fixture */}
                      <img src={`${IMG}/photo-desk-mug-duck.webp`} alt="" loading="lazy" style={{ objectPosition: "72% 50%", scale: "1.7", transformOrigin: "70% 82%" }} />
                    </span>
                  </span>
                </span>
                <Tag tone="ink" className="pn-landing-tag pn-landing-tag-a">
                  {t("en", "landing.sampleMug")}
                </Tag>
                <Tag tone="ink" className="pn-landing-tag pn-landing-tag-b">
                  {t("en", "landing.sampleDuck")}
                </Tag>
              </div>
              <StepText n={1} title={t("en", "landing.step1")} body={t("en", "landing.step1Body")} />
            </li>
            <li className="pn-landing-step">
              <div className="pn-landing-art pn-landing-art-stickers" aria-hidden="true">
                <Sticker src={`${IMG}/cutout-teal-mug.webp`} seed="step-mug" tilt={-0.7} size="58%" style={{ left: "2%", top: "14%" }} />
                <Sticker src={`${IMG}/cutout-rubber-duck.webp`} seed="step-duck" tilt={0.8} size="38%" style={{ left: "46%", top: "8%" }} />
                <Sticker src={`${IMG}/cutout-potted-succulent.webp`} seed="step-succulent" tilt={0.5} size="42%" style={{ left: "52%", top: "46%" }} />
              </div>
              <StepText n={2} title={t("en", "landing.step2")} body={t("en", "landing.step2Body")} />
            </li>
            <li className="pn-landing-step">
              <div className="pn-landing-art" aria-hidden="true">
                <span className="pn-print-wrap" style={{ "--t": 0.9 } as CSSProperties}>
                  <span className="pn-print">
                    <span className="pn-print-frame" style={{ aspectRatio: "1" }}>
                      {/* eslint-disable-next-line @next/next/no-img-element -- synthetic landing fixture */}
                      <img src={`${IMG}/scene-picnic-mug-duck.webp`} alt="" loading="lazy" style={{ objectPosition: "50% 62%" }} />
                    </span>
                    <span className="pn-print-meta">
                      <span className="pn-print-no">{tf("en", "ui.sceneNumber", { n: "01" })}</span>
                    </span>
                  </span>
                </span>
              </div>
              <StepText n={3} title={t("en", "landing.step3")} body={t("en", "landing.step3Body")} />
            </li>
          </ol>
        </section>

        <footer className="pn-landing-foot">
          <a href="https://github.com/MoriaCrew/Pinned">{t("en", "footer.source")}</a>
        </footer>
      </div>
    </main>
  );
}

function StepText({ n, title, body }: { n: number; title: string; body: string }) {
  return (
    <div className="pn-landing-step-text">
      <span className="pn-landing-step-no">{tf("en", "landing.stepNo", { n: String(n).padStart(2, "0") })}</span>
      <h3 className="pn-landing-step-title">{title}</h3>
      <p>{body}</p>
    </div>
  );
}
