import { t } from "../../i18n";
import { CreateGameForm } from "./CreateGameForm";

export default function CreatePage() {
  return (
    <main>
      <p className="eyebrow"><a href="/">Pinned</a></p>
      <h1 className="page-title">{t("en", "create.title")}</h1>
      <p className="lede">{t("en", "create.intro")}</p>
      <CreateGameForm />
    </main>
  );
}
