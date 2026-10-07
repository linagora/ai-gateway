import { CircleAlert, CircleCheck, CircleDashed, CircleMinus, type LucideIcon, TriangleAlert } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import type { Langue } from "@/lib/langue";
import { etatDesServices, type StatutService } from "@/lib/services/supervision";
import { getDeps, requireUser } from "@/lib/session";
import { RafraichissementAuto } from "../../(admin)/gestion/rafraichissement-auto";
import { COULEURS_NIVEAUX } from "../catalogue/couleurs";

/** Icône et couleur de chaque état ; le libellé de l'état est toujours écrit à côté. */
const APPARENCE: Record<StatutService, { icone: LucideIcon; classe: string }> = {
  operationnel: { icone: CircleCheck, classe: "text-green-700" },
  perturbe: { icone: TriangleAlert, classe: "text-amber-800" },
  incident: { icone: CircleAlert, classe: "text-red-800" },
  non_verifie: { icone: CircleDashed, classe: "text-neutral-600" },
  non_surveille: { icone: CircleMinus, classe: "text-neutral-600" },
};

/**
 * Onglet « État des services » (ticket #142), ouvert à tout collaborateur : l'état actuel de chaque modèle du catalogue,
 * tenu par la supervision de la passerelle, sans détail technique. La page se met à jour d'elle-même toutes les 30 secondes.
 */
export default async function EtatDesServicesPage() {
  await requireUser();
  const [t, tNiveaux, locale] = await Promise.all([getTranslations("etatServices"), getTranslations("domaine.niveaux"), getLocale()]);
  const langue: Langue = locale === "en" ? "en" : "fr";
  const modeles = await etatDesServices(getDeps(), langue);
  const compte = (statut: StatutService) => modeles.filter((m) => m.statut === statut).length;
  const [incidents, perturbes, operationnels] = [compte("incident"), compte("perturbe"), compte("operationnel")];
  const resume =
    incidents + perturbes === 0
      ? t("toutFonctionne")
      : [
          incidents > 0 && t("resume.incidents", { nombre: incidents }),
          perturbes > 0 && t("resume.perturbes", { nombre: perturbes }),
          operationnels > 0 && t("resume.operationnels", { nombre: operationnels }),
        ]
          .filter(Boolean)
          .join(" · ");
  const bandeau =
    incidents > 0 ? "border-red-300 bg-red-50 text-red-800" : perturbes > 0 ? "border-amber-300 bg-amber-50 text-amber-800" : "border-green-300 bg-green-50 text-green-800";
  const IconeBandeau = incidents > 0 ? CircleAlert : perturbes > 0 ? TriangleAlert : CircleCheck;

  return (
    <>
      <h1>{t("titre")}</h1>
      <p className="text-sm text-neutral-600">{t("intro")}</p>
      {modeles.length === 0 ? (
        <p className="italic">{t("aucun")}</p>
      ) : (
        <>
          <p role="status" className={`my-4 rounded border p-3 font-semibold ${bandeau}`}>
            <IconeBandeau aria-hidden="true" className="inline size-4 align-[-0.125em]" /> {resume}
          </p>
          <div className="overflow-x-auto">
            <table>
              <thead>
                <tr>
                  <th>{t("modele")}</th>
                  <th>{t("niveau")}</th>
                  <th>{t("etat")}</th>
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
                      </td>
                      <td>
                        <span className={`whitespace-nowrap rounded-xl border-2 px-2.5 text-sm ${COULEURS_NIVEAUX[m.dataLevel]}`}>{tNiveaux(m.dataLevel)}</span>
                      </td>
                      <td className={classe}>
                        <Icone aria-hidden="true" className="inline size-4 align-[-0.125em]" /> {t(`statuts.${m.statut}`)}
                        {m.since && <p className="mt-1 text-sm">{t(`depuis.${m.statut === "incident" ? "incident" : "perturbe"}`, { date: m.since })}</p>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
      <RafraichissementAuto />
    </>
  );
}
