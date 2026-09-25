import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { countAdminPending } from "@/lib/services/admin-requests";
import { getDeps, requireAdminPage } from "@/lib/session";
import { Pastille } from "../../pastille";

/** Menu d'administration ; ses pastilles comptent ce qui attend : demandes à valider, clés approuvées à retirer. */
export async function AdminNav() {
  const admin = await requireAdminPage();
  const [t, { demandes, clesARetirer }] = await Promise.all([getTranslations("gestion.nav"), countAdminPending(getDeps(), admin)]);
  return (
    <nav className="mb-4 flex gap-4 text-sm" aria-label={t("libelle")}>
      <Link href="/gestion/demandes">
        {t("demandes")}
        <Pastille nombre={demandes} libelle={t("aValider", { nombre: demandes })} />
      </Link>
      <Link href="/gestion/cles">
        {t("cles")}
        <Pastille nombre={clesARetirer} libelle={t("aRetirer", { nombre: clesARetirer })} />
      </Link>
      <Link href="/gestion/catalogue">{t("catalogue")}</Link>
      <Link href="/gestion/parametres">{t("parametres")}</Link>
    </nav>
  );
}
