import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { PortalError } from "@/lib/errors";
import { listEmployees } from "@/lib/services/employees";
import { getTeamOverview } from "@/lib/services/teams";
import { getDeps, requireGestionPage } from "@/lib/session";
import { AdminNav } from "../admin-nav";
import { LienSalarie } from "../lien-salarie";

/**
 * Onglet « Salariés » (retours de l'utilisateur du 2026-09-26) : les salariés connus du portail, avec leurs équipes,
 * leurs clés actives et leurs abonnements actifs, chacun menant à sa fiche ; pour un responsable, ceux de ses équipes.
 * La recherche (?q=) retient une partie d'uid ou d'adresse, et un uid exact ouvre directement la fiche ; avec
 * `?equipe=` (depuis le nombre de membres d'une équipe), la liste se limite à cette équipe.
 */
export default async function SalariesPage(props: PageProps<"/gestion/salaries">) {
  const acteur = await requireGestionPage();
  const [t, searchParams] = await Promise.all([getTranslations("gestion.salaries"), props.searchParams]);
  const recherche = typeof searchParams.q === "string" ? searchParams.q.trim() : "";
  const teamId = typeof searchParams.equipe === "string" ? searchParams.equipe : undefined;
  // Une équipe inconnue, ou hors de l'autorité d'un responsable, est introuvable.
  const equipe = teamId
    ? await getTeamOverview(getDeps(), acteur, teamId).catch((e: unknown) => {
        if (e instanceof PortalError && e.code === "introuvable") notFound();
        throw e;
      })
    : null;
  const salaries = await listEmployees(getDeps(), acteur, { recherche, equipe: teamId });
  const exact = salaries.find((s) => s.uid.toLocaleLowerCase("fr") === recherche.toLocaleLowerCase("fr"));
  if (recherche && exact) redirect(`/gestion/salaries/${encodeURIComponent(exact.uid)}`);

  return (
    <>
      <AdminNav />
      <h1>{t("titre")}</h1>
      {equipe && (
        <p className="flex flex-wrap items-center gap-3">
          <span>{t("filtreEquipe", { equipe: equipe.teamAlias })}</span>
          <Link href="/gestion/salaries">{t("tous")}</Link>
        </p>
      )}
      <form role="search" className="mb-4 flex flex-wrap items-end gap-3">
        {teamId && <input type="hidden" name="equipe" value={teamId} />}
        <label>
          {t("recherche")}
          <input name="q" defaultValue={recherche} />
        </label>
        <button type="submit">{t("rechercher")}</button>
      </form>
      {salaries.length === 0 ? (
        <p>{recherche ? t("aucunResultat", { recherche }) : t("aucun")}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>{t("colonnes.salarie")}</th>
              <th>{t("colonnes.equipes")}</th>
              <th>{t("colonnes.cles")}</th>
              <th>{t("colonnes.abonnements")}</th>
            </tr>
          </thead>
          <tbody>
            {salaries.map((s) => (
              <tr key={s.uid}>
                <td>
                  <LienSalarie uid={s.uid} />
                  {s.email && <span className="block text-xs text-neutral-600">{s.email}</span>}
                </td>
                <td>{s.teams.join(", ")}</td>
                <td>{s.activeKeyCount}</td>
                <td>{s.activeSubscriptionCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
