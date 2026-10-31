import type { Metadata } from "next";
import { t, tf } from "../../i18n";
import { getLocale } from "../../i18n/server";
import { getPolicy } from "../../policy/server";
import { StartFlow } from "./StartFlow";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getLocale();
  return {
    title: tf(locale, "create.pageTitle", { title: t(locale, "create.title") }),
    robots: { index: false, follow: false },
  };
}

/** Start a board (PIN-101): name it, then pick the look Spark suggests. */
export default function NewBoardPage() {
  return (
    <main className="pn-skin-root pn-start" data-theme="paper">
      <StartFlow titleMaxChars={getPolicy().boardTitleMaxChars} />
    </main>
  );
}
