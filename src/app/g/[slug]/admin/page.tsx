import { t } from "../../../../i18n";
import { AdminVerifier } from "./AdminVerifier";

export default async function AdminPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return (
    <main>
      <p className="eyebrow"><a href="/">Pinneds</a></p>
      <h1 className="page-title">{t("en", "admin.title")}</h1>
      <AdminVerifier slug={slug} />
    </main>
  );
}
