import type { Metadata } from "next";
import { t } from "../../i18n";
import { getPolicy } from "../../policy/server";
import { CreateBoardForm } from "./CreateBoardForm";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Start a board — Pinneds",
  robots: { index: false, follow: false },
};

export default function NewBoardPage() {
  return (
    <main>
      <p className="eyebrow"><a href="/">📌 Pinneds</a></p>
      <h1 className="page-title">{t("en", "create.title")}</h1>
      <CreateBoardForm titleMaxChars={getPolicy().boardTitleMaxChars} />
    </main>
  );
}
