import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { countAdminPending } from "@/lib/services/admin-requests";
import { getDeps, requireAdminPage } from "@/lib/session";

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

/** Pastille d'un nombre en attente ; les lecteurs d'écran lisent son libellé (« 2 demandes à valider »). Rien à zéro. */
function Pastille({ nombre, libelle }: { nombre: number; libelle: string }) {
  if (nombre === 0) return null;
  return (
    <>
      <span aria-hidden="true" className="ml-1.5 inline-flex min-w-5 items-center justify-center rounded-full bg-linagora px-1.5 text-xs font-semibold text-white">
        {nombre}
      </span>
      <span className="sr-only"> ({libelle})</span>
    </>
  );
}
