import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { listTeamOverviews } from "@/lib/services/teams";
import { getDeps, requireGestionPage } from "@/lib/session";
import { creerEquipeAction } from "../../../actions";
import { Notice } from "../../../components";
import { AdminNav } from "../admin-nav";

/** F-53 : les équipes de la passerelle, avec leurs membres réels et leurs clés actives, et la création d'une équipe. */
export default async function EquipesPage(props: PageProps<"/gestion/equipes">) {
  const admin = await requireGestionPage();
  const [t, searchParams, equipes] = await Promise.all([getTranslations("gestion.equipes"), props.searchParams, listTeamOverviews(getDeps(), admin)]);

  return (
    <>
      <AdminNav />
      <h1>{t("titre")}</h1>
      <Notice searchParams={searchParams} />
      {admin.isAdmin && (
        <form action={creerEquipeAction} className="flex flex-wrap items-end gap-3">
          <label>
            {t("nouvelle")}
            <input name="nom" required maxLength={100} />
          </label>
          <button type="submit">{t("creer")}</button>
        </form>
      )}
      {equipes.length === 0 ? (
        <p className="mt-6">{t("aucune")}</p>
      ) : (
        <table className="mt-6">
          <thead>
            <tr>
              <th>{t("colonnes.equipe")}</th>
              <th>{t("colonnes.responsables")}</th>
              <th>{t("colonnes.membres")}</th>
              <th>{t("colonnes.cles")}</th>
            </tr>
          </thead>
          <tbody>
            {equipes.map((e) => (
              <tr key={e.teamId}>
                <td>
                  <Link href={`/gestion/equipes/${encodeURIComponent(e.teamId)}`}>{e.teamAlias}</Link>
                </td>
                <td>{e.managerUids.join(", ") || t("aucun")}</td>
                <td>{e.memberCount}</td>
                <td>{e.activeKeyCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
