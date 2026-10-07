import { CircleAlert, CircleCheck, CircleDashed, CircleMinus, type LucideIcon } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import type { Langue } from "@/lib/langue";
import { etatDesModeles, SEUIL_ALERTE, type StatutModele } from "@/lib/services/supervision";
import { getDeps, requireAdminPage } from "@/lib/session";
import { sonderModelesAction } from "../../../actions";
import { Notice } from "../../../components";
import { AdminNav } from "../admin-nav";

/** Icône et couleur de chaque état ; le libellé de l'état est toujours écrit à côté. */
const APPARENCE: Record<StatutModele, { icone: LucideIcon; classe: string }> = {
  ok: { icone: CircleCheck, classe: "text-green-700" },
  en_panne: { icone: CircleAlert, classe: "text-red-800" },
  en_attente: { icone: CircleDashed, classe: "text-neutral-600" },
  non_supervise: { icone: CircleMinus, classe: "text-neutral-600" },
};

/**
 * Onglet « Supervision » (ticket #142), réservé aux admins : le dernier état de chaque modèle visible du catalogue, tenu par la sonde
 * régulière (SUPERVISION_INTERVAL_MINUTES), les modèles en panne d'abord. La page se met à jour d'elle-même avec la gestion (toutes les 30 secondes).
 */
export default async function SupervisionPage(props: PageProps<"/gestion/supervision">) {
  const admin = await requireAdminPage();
  const [t, locale, searchParams] = await Promise.all([getTranslations("gestion.supervision"), getLocale(), props.searchParams]);
  const langue: Langue = locale === "en" ? "en" : "fr";
  const deps = getDeps();
  const modeles = await etatDesModeles(deps, admin, langue);
  const enPanne = modeles.filter((m) => m.statut === "en_panne").length;

  return (
    <>
      <AdminNav />
      <h1>{t("titre")}</h1>
      <p className="text-sm text-neutral-600">{t("intro", { seuil: SEUIL_ALERTE, intervalle: deps.intervalleMinutes ?? 0 })}</p>
      <Notice searchParams={searchParams} />
      <form action={sonderModelesAction} className="my-4">
        <button type="submit" className="mt-0">
          {t("sonder")}
        </button>
      </form>

      {modeles.length === 0 ? (
        <p>{t("aucun")}</p>
      ) : (
        <>
          <p role="status" className={enPanne > 0 ? "font-semibold text-red-800" : undefined}>
            {t("resume", { enPanne })}
          </p>
          <div className="overflow-x-auto">
            <table>
              <thead>
                <tr>
                  <th>{t("modele")}</th>
                  <th>{t("etat")}</th>
                  <th>{t("depuis")}</th>
                  <th>{t("derniereSonde")}</th>
                  <th>{t("duree")}</th>
                  <th>{t("erreur")}</th>
                </tr>
              </thead>
              <tbody>
                {modeles.map((m) => {
                  const { icone: Icone, classe } = APPARENCE[m.statut];
                  return (
                    <tr key={m.modelName}>
                      <td>
                        {m.displayName}
                        <br />
                        <code className="text-xs">{m.modelName}</code>
                        {m.apiKind && <span className="text-xs text-neutral-600"> · {t(`typesApi.${m.apiKind}`)}</span>}
                      </td>
                      <td className={`whitespace-nowrap ${classe}`}>
                        <Icone aria-hidden="true" className="inline size-4 align-[-0.125em]" /> {t(`statuts.${m.statut}`)}
                      </td>
                      <td className="whitespace-nowrap">{m.since && t("date", { date: m.since })}</td>
                      <td className="whitespace-nowrap">{m.checkedAt && t("date", { date: m.checkedAt })}</td>
                      <td className="whitespace-nowrap">{m.latencyMs !== null && t("dureeValeur", { ms: m.latencyMs })}</td>
                      <td className="text-sm">
                        {m.statut === "non_supervise" ? t("nonSupervise") : m.error && <span className="break-words">{m.httpStatus ? t("erreurHttp", { statut: m.httpStatus, erreur: m.error }) : m.error}</span>}
                        {m.alertedAt && <p className="mt-1 text-xs text-neutral-600">{t("alerte", { date: m.alertedAt })}</p>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
