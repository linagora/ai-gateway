import { getTranslations } from "next-intl/server";
import { CATEGORIES_NOUVEAUTE, nouveautesPourAdmin } from "@/lib/services/nouveautes";
import { getDeps, requireAdminPage } from "@/lib/session";
import { creerNouveauteAction, publierNouveauteAction } from "../../../actions";
import { CategorieNouveaute } from "../../../categorie-nouveaute";
import { ExplicationObligatoires, formats, Notice } from "../../../components";
import { Obligatoire } from "../../../obligatoire";
import { AdminNav } from "../admin-nav";

/**
 * Spécification #124, ticket #130 : les admins rédigent une nouveauté en brouillon, puis la publient ; tous les
 * collaborateurs la voient alors signalée par la cloche, jusqu'à ce qu'ils l'aient lue.
 */
export default async function GestionNouveautesPage(props: PageProps<"/gestion/nouveautes">) {
  const admin = await requireAdminPage();
  const [t, domaine, { jour }, searchParams, liste] = await Promise.all([
    getTranslations("gestionNouveautes"),
    getTranslations("domaine"),
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
                  <td>
                    {!n.publishedAt && (
                      <form action={publierNouveauteAction}>
                        <input type="hidden" name="id" value={n.id} />
                        <button type="submit" className="mt-0" aria-label={t("publierLaNouveaute", { titre: n.title })}>
                          {t("publier")}
                        </button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <h2>{t("rediger")}</h2>
      <ExplicationObligatoires />
      <form action={creerNouveauteAction} aria-label={t("rediger")} className="max-w-3xl">
        <label>
          {t("categorie")}
          <select name="category" defaultValue="MODELES">
            {CATEGORIES_NOUVEAUTE.map((c) => (
              <option key={c} value={c}>
                {domaine(`categoriesNouveaute.${c}`)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("titreFr")}
          <Obligatoire />
          <input name="titleFr" required maxLength={120} />
        </label>
        <label>
          {t("resumeFr")}
          <Obligatoire />
          <textarea name="summaryFr" required maxLength={300} rows={2} aria-describedby="aide-resume" />
        </label>
        <p id="aide-resume" className="text-xs text-neutral-600">
          {t("aideResume")}
        </p>
        <label>
          {t("texteFr")}
          <Obligatoire />
          <textarea name="bodyFr" required maxLength={20000} rows={8} aria-describedby="aide-texte" />
        </label>
        <p id="aide-texte" className="text-xs text-neutral-600">
          {t("aideTexte")}
        </p>
        <button type="submit">{t("enregistrer")}</button>
      </form>
    </>
  );
}
