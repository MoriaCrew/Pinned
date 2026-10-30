import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getConfig } from "../../../config";
import { cx } from "../../../ui";
import { SamLab } from "./SamLab";
import styles from "./lab.module.css";

export const metadata: Metadata = { title: "SAM lab — Pinned" };

/** Dev-only SAM exploration tool (PIN-36). 404 everywhere else. */
export default function SamLabPage() {
  const cfg = getConfig();
  if (!cfg.labEnabled && cfg.dataBackend !== "memory") notFound();
  return (
    <main className={cx("pn-skin-root", styles.shell)} data-theme="paper">
      <p className={styles.eyebrow}>Pinned · lab</p>
      <h1 className={styles.title}>✂️ SAM lab</h1>
      <p className={styles.lede}>Upload → name or tap the object → see the cut-out.</p>
      <SamLab aiMock={cfg.aiMock} />
    </main>
  );
}
