import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { nouveautesPourAdmin } from "@/lib/services/nouveautes";
import { getDeps, requireAdminPage } from "@/lib/session";
import { publierNouveauteAction, supprimerNouveauteAction } from "../../../actions";
import { CategorieNouveaute } from "../../../categorie-nouveaute";
import { ExplicationObligatoires, formats, Notice } from "../../../components";
import { AdminNav } from "../admin-nav";
import { FormulaireNouveaute } from "./formulaire";

/**
 * Spécification #124, tickets #130 et #134 : les admins rédigent une nouveauté en brouillon, la prévisualisent, puis la
 * publient ; tous les collaborateurs la voient alors signalée par la cloche, jusqu'à ce qu'ils l'aient lue. Ils la
 * corrigent ou la suppriment ensuite, et voient combien de collaborateurs l'ont lue, sans leurs noms.
 */
export default async function GestionNouveautesPage(props: PageProps<"/gestion/nouveautes">) {
  const admin = await requireAdminPage();
  const [t, { jour, nombre }, searchParams, liste] = await Promise.all([
    getTranslations("gestionNouveautes"),
    formats(),
    props.searchParams,
    nouveautesPourAdmin(getDeps(), admin),
  ]);

  return (
    <>
      <AdminNav />
      <h1>{t("titre")}</h1>
      <p className="text-sm text-neutral-600">{t("introduction")}</p>
      <Notice searchParams={searchParams} />
      <h2>{t("liste")}</h2>
      {liste.length === 0 ? (
        <p className="italic">{t("aucune")}</p>
      ) : (
        <div className="overflow-x-auto">
          <table>
            <thead>
              <tr>
                <th>{t("colonnes.categorie")}</th>
                <th>{t("colonnes.titre")}</th>
                <th>{t("colonnes.etat")}</th>
                <th>{t("colonnes.lectures")}</th>
                <th>{t("colonnes.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {liste.map((n) => (
                <tr key={n.id}>
                  <td>
                    <CategorieNouveaute category={n.category} />
                  </td>
                  <td>{n.title}</td>
                  <td>{n.publishedAt ? t("publieeLe", { date: jour(n.publishedAt) }) : t("brouillon")}</td>
                  {/* Un brouillon n'a pas encore de lecteurs : cellule vide. */}
                  <td>{n.publishedAt && nombre(n.lectures)}</td>
                  <td>
                    <div className="flex flex-wrap items-start gap-x-4 gap-y-1">
                      <Link href={`/gestion/nouveautes/${n.id}`} aria-label={t("corrigerLaNouveaute", { titre: n.title })}>
                        {t("corriger")}
                      </Link>
                      <Link href={`/nouveautes/${n.id}`} aria-label={t("apercuDeLaNouveaute", { titre: n.title })}>
                        {t("apercu")}
                      </Link>
                      {!n.publishedAt && (
                        <form action={publierNouveauteAction}>
                          <input type="hidden" name="id" value={n.id} />
                          <button type="submit" className="mt-0" aria-label={t("publierLaNouveaute", { titre: n.title })}>
                            {t("publier")}
                          </button>
                        </form>
                      )}
                      <details>
                        <summary className="cursor-pointer" aria-label={t("supprimerLaNouveaute", { titre: n.title })}>
                          {t("supprimer")}
                        </summary>
                        <p className="text-sm">{t("suppressionAvertissement")}</p>
                        <form action={supprimerNouveauteAction}>
                          <input type="hidden" name="id" value={n.id} />
                          <button type="submit">{t("confirmerSuppression")}</button>
                        </form>
                      </details>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <h2>{t("rediger")}</h2>
      <ExplicationObligatoires />
      <FormulaireNouveaute />
    </>
  );
}
