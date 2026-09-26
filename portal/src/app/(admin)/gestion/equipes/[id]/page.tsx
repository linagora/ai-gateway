import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { joursDePeriode } from "@/lib/durees";
import { PortalError } from "@/lib/errors";
import { getTeamPage, type TeamBudget } from "@/lib/services/teams";
import { getDeps, requireGestionPage } from "@/lib/session";
import {
  ajouterMembreAction,
  designerResponsableAction,
  faireSortirMembreAction,
  fixerBudgetEquipeAction,
  renommerEquipeAction,
  retirerResponsableAction,
  supprimerEquipeAction,
} from "../../../../actions";
import { DepenseSurBudget, formats, Notice } from "../../../../components";
import { AdminNav } from "../../admin-nav";

/**
 * F-53 et F-54 : page d'une équipe : son résumé, son renommage, son budget, ses responsables et ses membres
 * (ajout direct, sortie d'une équipe), et sa suppression. Un responsable d'équipe la consulte et peut en faire sortir
 * un membre ; le reste est réservé aux admins.
 */
export default async function EquipePage(props: PageProps<"/gestion/equipes/[id]">) {
  const acteur = await requireGestionPage();
  const estAdmin = acteur.isAdmin;
  const [{ id }, t, searchParams, { date }] = await Promise.all([props.params, getTranslations("gestion.equipes"), props.searchParams, formats()]);
  const equipe = await getTeamPage(getDeps(), acteur, decodeURIComponent(id)).catch((e: unknown) => {
    if (e instanceof PortalError && e.code === "introuvable") notFound();
    throw e;
  });

  return (
    <>
      <AdminNav />
      <p>
        <Link href="/gestion/equipes" className="inline-flex items-center gap-1">
          <ArrowLeft aria-hidden="true" className="size-4" />
          {t("toutes")}
        </Link>
      </p>
      <h1>{equipe.teamAlias}</h1>
      <Notice searchParams={searchParams} />
      <dl className="grid grid-cols-[12rem_1fr] gap-x-4 gap-y-1" aria-label={t("resume")}>
        <dt>{t("colonnes.membres")}</dt>
        <dd>{equipe.memberCount}</dd>
        <dt>{t("colonnes.cles")}</dt>
        <dd>
          <Link href={`/gestion/cles?equipe=${encodeURIComponent(equipe.teamId)}`} aria-label={t("voirCles", { nombre: equipe.activeKeyCount })}>
            {equipe.activeKeyCount}
          </Link>
        </dd>
      </dl>
      {estAdmin && (
        <form action={renommerEquipeAction} className="mt-6 flex flex-wrap items-end gap-3">
          <input type="hidden" name="id" value={equipe.teamId} />
          <label>
            {t("nom")}
            <input name="nom" required maxLength={100} defaultValue={equipe.teamAlias} />
          </label>
          <button type="submit">{t("renommer")}</button>
        </form>
      )}

      <section aria-labelledby="budget" className="mt-8">
        <h2 id="budget">{t("budget.titre")}</h2>
        <dl className="grid grid-cols-[12rem_1fr] gap-x-4 gap-y-1">
          <dt>{t("budget.plafond")}</dt>
          <dd>
            <BudgetEquipe budget={equipe.budget} />
          </dd>
          {equipe.budget.max !== null && (
            <>
              <dt>{t("budget.depense")}</dt>
              <dd>
                <DepenseSurBudget spend={equipe.budget.spend} maxBudget={equipe.budget.max} />
              </dd>
            </>
          )}
          {equipe.budget.max !== null && equipe.budget.resetAt && (
            <>
              <dt>{t("budget.remiseAZero")}</dt>
              <dd>{date(equipe.budget.resetAt)}</dd>
            </>
          )}
        </dl>
        {estAdmin && (
          <form action={fixerBudgetEquipeAction} className="mt-4 flex flex-wrap items-end gap-3">
            <input type="hidden" name="id" value={equipe.teamId} />
            <label>
              {t("budget.montant")}
              <input name="budget" type="number" min="0" step="0.01" required defaultValue={equipe.budget.max ?? 0} />
            </label>
            <label>
              {t("budget.periode")}
              <input name="periode" defaultValue={equipe.budget.period ?? ""} />
            </label>
            <button type="submit">{t("budget.enregistrer")}</button>
            <p className="basis-full text-sm text-neutral-600">{t("budget.aide")}</p>
          </form>
        )}
      </section>

      <section aria-labelledby="responsables" className="mt-8">
        <h2 id="responsables">{t("responsables")}</h2>
        {equipe.managers.length === 0 ? (
          <p>{t("aucunResponsable")}</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>{t("colonneResponsable")}</th>
                <th>{t("colonneAdresse")}</th>
                {estAdmin && <th />}
              </tr>
            </thead>
            <tbody>
              {equipe.managers.map((m) => (
                <tr key={m.uid}>
                  <td>{m.uid}</td>
                  <td>{m.email}</td>
                  {estAdmin && (
                    <td>
                      <form action={retirerResponsableAction}>
                        <input type="hidden" name="id" value={equipe.teamId} />
                        <input type="hidden" name="uid" value={m.uid} />
                        <button type="submit" className="border-neutral-400 bg-white text-neutral-800 hover:bg-neutral-100">
                          {t("retirerRole")}
                        </button>
                      </form>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {estAdmin && (
          <form action={designerResponsableAction} className="mt-4 flex flex-wrap items-end gap-3">
            <input type="hidden" name="id" value={equipe.teamId} />
            <label>
              {t("uidResponsable")}
              <input name="uid" required />
            </label>
            <button type="submit">{t("designer")}</button>
          </form>
        )}
      </section>

      <section aria-labelledby="membres" className="mt-8">
        <h2 id="membres">{t("membres")}</h2>
        {equipe.members.length === 0 ? (
          <p>{t("aucunMembre")}</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>{t("colonneMembre")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {equipe.members.map((uid) => (
                <tr key={uid}>
                  <td>{uid}</td>
                  {/* Un admin ou un responsable de l'équipe peut faire sortir un membre ; un responsable, seul un admin (F-54). */}
                  <td>
                    {(estAdmin || !equipe.managers.some((m) => m.uid === uid)) && (
                      <details>
                        <summary className="cursor-pointer">{t("faireSortir")}</summary>
                        <p className="text-sm">{t("avertissementSortie")}</p>
                        <form action={faireSortirMembreAction}>
                          <input type="hidden" name="id" value={equipe.teamId} />
                          <input type="hidden" name="uid" value={uid} />
                          <button type="submit">{t("confirmerSortie")}</button>
                        </form>
                      </details>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {estAdmin && (
          <form action={ajouterMembreAction} className="mt-4 flex flex-wrap items-end gap-3">
            <input type="hidden" name="id" value={equipe.teamId} />
            <label>
              {t("uid")}
              <input name="uid" required />
            </label>
            <button type="submit">{t("ajouter")}</button>
          </form>
        )}
      </section>

      {estAdmin && (
        <section aria-labelledby="suppression" className="mt-10">
          <h2 id="suppression">{t("suppression.titre")}</h2>
          <details>
            <summary className="cursor-pointer">{t("suppression.supprimer")}</summary>
            <p className="text-sm">{t("suppression.avertissement")}</p>
            <form action={supprimerEquipeAction}>
              <input type="hidden" name="id" value={equipe.teamId} />
              <button type="submit">{t("suppression.confirmer")}</button>
            </form>
          </details>
        </section>
      )}
    </>
  );
}

/** Budget d'une équipe : « 50,00 € par période de 30 jours », ou « Sans limite » ; une période hors jours (12h…) reste telle quelle. */
async function BudgetEquipe({ budget }: { budget: TeamBudget }) {
  const [t, domaine, { euros }] = await Promise.all([getTranslations("gestion.equipes.budget"), getTranslations("domaine"), formats()]);
  if (budget.max === null) return <>{t("sansLimite")}</>;
  if (budget.period === null) return <>{euros(budget.max)}</>;
  const jours = joursDePeriode(budget.period);
  return <>{t("valeur", { montant: budget.max, periode: jours !== null ? domaine("dureeEnJours", { nombre: jours }) : budget.period })}</>;
}
