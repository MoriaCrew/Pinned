"use client";

import { Fragment, useState } from "react";
import { stepAfter } from "../../domain/walkthrough";
import { t, tf, type MessageKey } from "../../i18n";
import { useLocale } from "../../i18n/client";
import { Button, Icon, Pin, SceneCard, Sticker, Tag, type IconName } from "../../ui";
import { EXAMPLE, MODEL_NAMES } from "./models.data";
import styles from "./models.module.css";

interface Step {
  title: MessageKey;
  body: MessageKey;
  models: { name: string; icon: IconName }[];
}

const STEPS: Step[] = [
  { title: "models.step1.title", body: "models.step1.body", models: [{ name: MODEL_NAMES.spark, icon: "pin" }] },
  { title: "models.step2.title", body: "models.step2.body", models: [{ name: MODEL_NAMES.sam, icon: "cut" }] },
  {
    title: "models.step3.title",
    body: "models.step3.body",
    models: [
      { name: MODEL_NAMES.spark, icon: "pin" },
      { name: MODEL_NAMES.voice, icon: "mic" },
    ],
  },
  { title: "models.step4.title", body: "models.step4.body", models: [{ name: MODEL_NAMES.image, icon: "scene" }] },
];

/** `data-active` + `aria-hidden` for one stacked layer: every layer shares one grid cell, so nothing below moves. */
function shown(active: boolean) {
  return { "data-active": active ? "" : undefined, "aria-hidden": active ? undefined : true };
}

/**
 * The walk-through (PIN-237): one real example from photo to scene,
 * one model per step. Pictures and texts are stacked so the controls
 * never move; a hidden live line says which step is showing. Reduced
 * motion: the global guard turns every transition off, states only.
 */
export function ModelsWalkthrough() {
  const locale = useLocale();
  const [step, setStep] = useState(0);
  const [moved, setMoved] = useState(false);
  const go = (next: number) => {
    setStep(next);
    setMoved(true);
  };
  const total = STEPS.length;
  const last = step === total - 1;
  const owner = EXAMPLE.photo.owner;
  const current = STEPS[step] ?? STEPS[0];
  return (
    <div className={styles.walk}>
      <div className={styles.stage}>
        <div className={styles.layer} {...shown(step <= 1)}>
          <div className={styles.photo} data-cut={step === 1 ? "" : undefined}>
            <img src={EXAMPLE.photo.src} alt={tf(locale, "models.photoAlt", { owner })} />
            {EXAMPLE.things.map((thing) => {
              const { left, top, width, height } = thing.box;
              return (
                <Fragment key={thing.sticker}>
                  <span className={styles.outline} style={{ left: `${left}%`, top: `${top}%`, width: `${width}%`, height: `${height}%` }} />
                  <span className={styles.cut} style={{ left: `${left}%`, top: `${top}%`, width: `${width}%`, height: `${height}%` }}>
                    <Sticker src={thing.src} tilt={0} />
                  </span>
                  <span className="pn-cut-label" style={{ left: `${left + width / 2}%`, top: `${top}%` }}>
                    <span>{t(locale, thing.label)}</span>
                  </span>
                </Fragment>
              );
            })}
          </div>
        </div>

        <div className={styles.layer} {...shown(step === 2)}>
          <ul className={styles.picks}>
            {EXAMPLE.picks.map((pick, index) => (
              <Pin key={pick.sticker} as="li" src={pick.src} label={t(locale, pick.label)} owner={pick.owner} seed={pick.sticker} state="picked" pickIndex={index + 1} />
            ))}
          </ul>
          <p className={styles.idea}>
            <Icon name="mic" size={20} />
            {tf(locale, "ui.quoted", { text: t(locale, "models.idea") })}
          </p>
        </div>

        <div className={styles.layer} {...shown(step === 3)}>
          <SceneCard
            src={EXAMPLE.scene}
            alt={t(locale, "models.sceneAlt")}
            idea={t(locale, "models.idea")}
            credits={EXAMPLE.picks.map((pick) => ({ thing: t(locale, pick.label), owner: pick.owner, src: pick.src }))}
            ratio="1 / 1"
            tilt={0.6}
            className={styles.print}
          />
        </div>
      </div>

      <div className={styles.texts}>
        {STEPS.map((item, index) => (
          <div key={item.title} className={styles.text} {...shown(index === step)}>
            <p className={styles.count}>{tf(locale, "models.stepOf", { n: index + 1, total })}</p>
            <p className={styles.tags}>
              {item.models.map((model) => (
                <Tag key={model.name} tone="mark" icon={model.icon}>
                  {model.name}
                </Tag>
              ))}
            </p>
            <h3 className={styles.stepTitle}>{t(locale, item.title)}</h3>
            <p className={styles.body}>{tf(locale, item.body, { owner })}</p>
          </div>
        ))}
      </div>
      <p className="pn-sr" aria-live="polite">
        {moved ? tf(locale, "models.stepAnnounce", { n: step + 1, total, title: t(locale, current.title) }) : ""}
      </p>

      <ol className={styles.dots} aria-label={t(locale, "models.stepsLabel")}>
        {STEPS.map((item, index) => (
          <li key={item.title}>
            <button
              type="button"
              className={`${styles.dot} pn-focusable`}
              aria-current={index === step ? "step" : undefined}
              aria-label={tf(locale, "models.goToStep", { n: index + 1, title: t(locale, item.title) })}
              onClick={() => go(index)}
            >
              <span aria-hidden="true" />
            </button>
          </li>
        ))}
      </ol>
      <div className={styles.nav}>
        <Button
          variant="quiet"
          icon="back"
          aria-disabled={step === 0 ? true : undefined}
          onClick={() => (step > 0 ? go(stepAfter(step, "back", total)) : undefined)}
        >
          {t(locale, "models.back")}
        </Button>
        <Button variant="secondary" icon={last ? "undo" : undefined} iconEnd={last ? undefined : "arrow"} onClick={() => go(stepAfter(step, "next", total))}>
          {t(locale, last ? "models.again" : "models.next")}
        </Button>
      </div>
    </div>
  );
}
