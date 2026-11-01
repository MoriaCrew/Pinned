import type { Metadata } from "next";
import { LOCALES, t, tf, type Locale, type MessageKey } from "../../i18n";
import { getLocale } from "../../i18n/server";
import { getPolicy } from "../../policy/server";
import { ButtonLink, Icon, Tag, Wordmark, type IconName } from "../../ui";
import { SiteLinks } from "../_legal/LegalParts";
import { MODEL_NAMES, MODELS_DOC_URL } from "./models.data";
import { ModelsWalkthrough } from "./ModelsWalkthrough";
import styles from "./models.module.css";

// Policy (sceneStore) decides one line: render per request, like /privacy.
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getLocale();
  return {
    title: tf(locale, "legal.pageTitle", { title: t(locale, "models.pageTitle") }),
    description: t(locale, "models.lead"),
  };
}

interface ModelCard {
  name: string;
  icon: IconName;
  runtime: boolean;
  does: MessageKey;
  sees: MessageKey;
  never: MessageKey;
}

const CARDS: ModelCard[] = [
  { name: MODEL_NAMES.spark, icon: "pin", runtime: true, does: "models.spark.does", sees: "models.spark.sees", never: "models.spark.never" },
  { name: MODEL_NAMES.sam, icon: "cut", runtime: true, does: "models.sam.does", sees: "models.sam.sees", never: "models.sam.never" },
  { name: MODEL_NAMES.image, icon: "scene", runtime: true, does: "models.image.does", sees: "models.image.sees", never: "models.image.never" },
  { name: MODEL_NAMES.voice, icon: "mic", runtime: true, does: "models.voice.does", sees: "models.voice.sees", never: "models.voice.never" },
  { name: MODEL_NAMES.open, icon: "info", runtime: false, does: "models.open.does", sees: "models.open.sees", never: "models.open.never" },
];

/**
 * How Pinneds uses Meta's models (PIN-237): the landing's "How each
 * model is used" link. A visitor's version of docs/19: one real example
 * step by step (a client island), what each model sees and never sees,
 * and how the site was built. No board data and no AI calls; every
 * claim follows docs/19 and the README.
 */
export default async function ModelsPage() {
  const locale = await getLocale();
  const otherLanguages = LOCALES.length - 1;
  return (
    <main className={`pn-skin-root ${styles.page}`} data-theme="paper">
      <header className="pn-head">
        <div className="pn-head-row">
          <Wordmark size={22} href="/" />
        </div>
      </header>
      <article className={styles.doc} aria-labelledby="models-title">
        <div className={styles.intro}>
          <h1 id="models-title" className={styles.title}>
            {t(locale, "models.pageTitle")}
          </h1>
          <p className={styles.lead}>{t(locale, "models.lead")}</p>
        </div>

        <section className={styles.section} aria-labelledby="models-walk">
          <h2 id="models-walk" className="pn-section-title">
            {t(locale, "models.walkTitle")}
          </h2>
          <p>{t(locale, "models.walkIntro")}</p>
          <ModelsWalkthrough />
        </section>

        <section className={styles.section} aria-labelledby="models-cards">
          <h2 id="models-cards" className="pn-section-title">
            {t(locale, "models.cardsTitle")}
          </h2>
          <p>{t(locale, "models.cardsIntro")}</p>
          <ul className={styles.cards}>
            {CARDS.map((card) => (
              <ModelCardItem key={card.name} locale={locale} card={card} otherLanguages={otherLanguages} />
            ))}
          </ul>
          <div className={styles.privacy}>
            <p>{t(locale, "models.originals")}</p>
            <p>{t(locale, "models.standardMode")}</p>
            {getPolicy().sceneStore ? null : <p>{t(locale, "models.noStore")}</p>}
          </div>
        </section>

        <section className={styles.section} aria-labelledby="models-built">
          <h2 id="models-built" className="pn-section-title">
            {t(locale, "models.builtTitle")}
          </h2>
          <p>{tf(locale, "models.builtBody", { n: otherLanguages })}</p>
          <div className={styles.actions}>
            <ButtonLink variant="primary" size="lg" icon="plus" href="/new">
              {t(locale, "landing.start")}
            </ButtonLink>
          </div>
        </section>
      </article>
      <footer className={styles.foot}>
        <SiteLinks locale={locale}>
          <a href={MODELS_DOC_URL}>{t(locale, "models.technical")}</a>
        </SiteLinks>
      </footer>
    </main>
  );
}

function ModelCardItem({ locale, card, otherLanguages }: { locale: Locale; card: ModelCard; otherLanguages: number }) {
  return (
    <li className={styles.card}>
      <div className={styles.cardHead}>
        <Icon name={card.icon} size={22} />
        <h3 className={styles.cardName}>{card.name}</h3>
        <Tag tone={card.runtime ? "ink" : "outline"}>{t(locale, card.runtime ? "models.inApp" : "models.buildTime")}</Tag>
      </div>
      <p>{tf(locale, card.does, { n: otherLanguages })}</p>
      <dl className={styles.facts}>
        <dt>{t(locale, "models.sees")}</dt>
        <dd>{t(locale, card.sees)}</dd>
        <dt>{t(locale, "models.neverSees")}</dt>
        <dd>{t(locale, card.never)}</dd>
      </dl>
    </li>
  );
}
