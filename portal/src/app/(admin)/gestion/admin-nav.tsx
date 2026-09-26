import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { countAdminPending } from "@/lib/services/admin-requests";
import { getDeps, requireGestionPage } from "@/lib/session";
import { Pastille } from "../../pastille";

/**
 * Menu de la gestion ; ses pastilles comptent ce qui attend : demandes à valider, clés approuvées à retirer, abonnements
 * approuvés à déclarer. Un responsable d'équipe n'y voit que les demandes, les clés, les abonnements et les équipes (F-54).
 */
export async function AdminNav() {
  const admin = await requireGestionPage();
  const [t, { demandes, clesARetirer, abonnementsADeclarer }] = await Promise.all([getTranslations("gestion.nav"), countAdminPending(getDeps(), admin)]);
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
      <Link href="/gestion/abonnements">
        {t("abonnements")}
        <Pastille nombre={abonnementsADeclarer} libelle={t("aDeclarer", { nombre: abonnementsADeclarer })} />
      </Link>
      <Link href="/gestion/equipes">{t("equipes")}</Link>
      {admin.isAdmin && (
        <>
          <Link href="/gestion/catalogue">{t("catalogue")}</Link>
          <Link href="/gestion/parametres">{t("parametres")}</Link>
          <Link href="/gestion/outils">{t("outils")}</Link>
        </>
      )}
    </nav>
  );
}
