import Link from "next/link";
import { getTranslations } from "next-intl/server";

export async function AdminNav() {
  const t = await getTranslations("gestion.nav");
  return (
    <nav className="mb-4 flex gap-4 text-sm" aria-label={t("libelle")}>
      <Link href="/gestion/demandes">{t("demandes")}</Link>
      <Link href="/gestion/cles">{t("cles")}</Link>
      <Link href="/gestion/catalogue">{t("catalogue")}</Link>
      <Link href="/gestion/parametres">{t("parametres")}</Link>
    </nav>
  );
}
