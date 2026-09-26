import { ExternalLink } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { requireAdminPage } from "@/lib/session";
import { AdminNav } from "../admin-nav";

/**
 * Fonctions réservées aux admins hors du portail, servies par d'autres services derrière son point de contrôle :
 * le reporting (Superset, /stats) et la passerelle (console LiteLLM, /admin, filtrée par adresse IP). Liens
 * ordinaires, et non next/link : ces chemins ne sont pas des pages du portail, qui ne doit jamais les servir.
 */
export default async function OutilsPage() {
  await requireAdminPage();
  const t = await getTranslations("gestion.outils");
  const lien = (adresse: string, libelle: string) => (
    <li>
      <a href={adresse} target="_blank" rel="noopener">
        {libelle}
        {" "}
        <ExternalLink aria-hidden="true" className="inline size-3.5 align-[-0.125em]" />
        <span className="sr-only"> ({t("nouvelOnglet")})</span>
      </a>
    </li>
  );

  return (
    <>
      <AdminNav />
      <h1>{t("titre")}</h1>
      <p>{t("intro")}</p>

      <section aria-labelledby="outil-reporting" className="mt-6">
        <h2 id="outil-reporting">{t("reporting.titre")}</h2>
        <p>{t("reporting.description")}</p>
        <ul className="mt-2 space-y-1">
          {lien("/stats/superset/dashboard/consommation/", t("reporting.consommation"))}
          {lien("/stats/superset/dashboard/pilotage/", t("reporting.pilotage"))}
          {lien("/stats/superset/dashboard/par-salarie/", t("reporting.parSalarie"))}
          {lien("/stats/", t("reporting.accueil"))}
        </ul>
      </section>

      <section aria-labelledby="outil-passerelle" className="mt-6">
        <h2 id="outil-passerelle">{t("passerelle.titre")}</h2>
        <p>{t("passerelle.description")}</p>
        <p className="text-sm text-neutral-600">{t("passerelle.avertissement")}</p>
        <ul className="mt-2 space-y-1">
          {lien("/admin/ui/", t("passerelle.console"))}
          {lien("/admin/openapi.json", t("passerelle.openapi"))}
        </ul>
      </section>
    </>
  );
}
