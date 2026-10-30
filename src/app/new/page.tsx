import type { Metadata } from "next";
import { t } from "../../i18n";
import { getPolicy } from "../../policy/server";
import { StartFlow } from "./StartFlow";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: `${t("en", "create.title")} — Pinneds`,
  robots: { index: false, follow: false },
};

/** Start a board (PIN-101): name it, then pick the look Spark suggests. */
export default function NewBoardPage() {
  return (
    <main className="pn-skin-root pn-start" data-theme="paper">
      <StartFlow titleMaxChars={getPolicy().boardTitleMaxChars} />
    </main>
  );
}
