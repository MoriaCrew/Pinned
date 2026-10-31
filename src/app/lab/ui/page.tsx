import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getConfig } from "../../../config";
import { UiLab } from "./UiLab";

export const metadata: Metadata = { title: "UI lab — Pinneds", robots: { index: false, follow: false } };

/** Design-system preview (PIN-97): every component in every skin. Same gate as /lab/sam. */
export default function UiLabPage() {
  const cfg = getConfig();
  if (!cfg.labEnabled && cfg.dataBackend !== "memory") notFound();
  return <UiLab />;
}
