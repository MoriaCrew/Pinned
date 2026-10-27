import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getConfig } from "../../../config";
import { SamLab } from "./SamLab";

export const metadata: Metadata = { title: "SAM lab — Pinned" };

/** Dev-only SAM exploration tool (PIN-36). 404 everywhere else. */
export default function SamLabPage() {
  const cfg = getConfig();
  if (!cfg.labEnabled && cfg.dataBackend !== "memory") notFound();
  return (
    <main className="shell">
      <p className="eyebrow">Pinned · lab</p>
      <h1>✂️ SAM lab</h1>
      <p className="lede">Upload → name or tap the object → see the cut-out.</p>
      <SamLab aiMock={cfg.aiMock} />
    </main>
  );
}
