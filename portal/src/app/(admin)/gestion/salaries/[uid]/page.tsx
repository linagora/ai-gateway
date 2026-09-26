import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { PortalError } from "@/lib/errors";
import { getEmployeePage } from "@/lib/services/employees";
import { getDeps, requireGestionPage } from "@/lib/session";
import { DepenseSurBudget, formats, Notice } from "../../../../components";
import { ActionsAbonnement, ActionsCle } from "../../actions-gestion";
import { AdminNav } from "../../admin-nav";

/**
 * Fiche d'un salarié (retours de l'utilisateur du 2026-09-26) : ses équipes, ses clés et ses abonnements en cours, avec
 * les actions de la gestion (blocage et révocation d'une clé ; demande ou déclaration de la résiliation d'un
 * abonnement), qui ramènent à la fiche. Un responsable d'équipe n'y voit que ce qui relève de ses équipes.
 */
export default async function SalariePage(props: PageProps<"/gestion/salaries/[uid]">) {
  const acteur = await requireGestionPage();
  const [{ uid }, t, tCles, tAbonnements, cles, domaine, searchParams, { date, euros, jour }] = await Promise.all([
    props.params,
    getTranslations("gestion.salaries"),
    getTranslations("gestion.cles"),
    getTranslations("gestion.abonnements"),
    getTranslations("cles"),
    getTranslations("domaine"),
    props.searchParams,
    formats(),
  ]);
  const fiche = await getEmployeePage(getDeps(), acteur, decodeURIComponent(uid)).catch((e: unknown) => {
    if (e instanceof PortalError && e.code === "introuvable") notFound();
    throw e;
  });
  const retour = { salarie: fiche.uid };
  const sousTitre = "mt-4 mb-2 font-semibold";

  return (
    <>
      <AdminNav />
      <p>
        <Link href="/gestion/salaries" className="inline-flex items-center gap-1">
          <ArrowLeft aria-hidden="true" className="size-4" />
          {t("tous")}
        </Link>
      </p>
      <h1 className="mb-1">{fiche.uid}</h1>
      {fiche.email && <p className="mb-4 text-neutral-600">{fiche.email}</p>}
      <Notice searchParams={searchParams} />

      <section aria-labelledby="equipes">
        <h2 id="equipes">{t("equipes")}</h2>
        {fiche.teams.length === 0 ? (
          <p>{t("aucuneEquipe")}</p>
        ) : (
          <ul className="flex flex-wrap gap-x-6 gap-y-1">
            {fiche.teams.map((e) => (
              <li key={e.teamId}>
                <Link href={`/gestion/equipes/${encodeURIComponent(e.teamId)}`}>{e.teamAlias}</Link>
                {e.manager && <span className="text-sm text-neutral-600"> ({t("responsable")})</span>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="cles">
        <h2 id="cles">{t("cles")}</h2>
        {fiche.keysToPickUp.length > 0 && (
          <>
            <h3 className={sousTitre}>{t("clesARetirer")}</h3>
            <table>
              <thead>
                <tr>
                  <th>{tCles("colonnes.equipe")}</th>
                  <th>{tCles("colonnes.niveau")}</th>
                  <th>{tCles("aRetirer.colonnes.modeles")}</th>
                  <th>{tCles("aRetirer.colonnes.approuvee")}</th>
                  <th>{tCles("aRetirer.colonnes.echeance")}</th>
                </tr>
              </thead>
              <tbody>
                {fiche.keysToPickUp.map((d) => (
                  <tr key={d.requestId}>
                    <td>{d.teamAlias}</td>
                    <td>{domaine(`niveaux.${d.dataLevel}`)}</td>
                    <td>{d.models.join(", ")}</td>
                    <td>{d.approvedAt ? date(d.approvedAt) : ""}</td>
                    <td>{d.pickupDeadline ? date(d.pickupDeadline) : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        <h3 className={sousTitre}>{tCles("actives")}</h3>
        {fiche.activeKeys.length === 0 ? (
          <p>{tCles("aucuneActive")}</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>{tCles("colonnes.alias")}</th>
                <th>{tCles("colonnes.equipe")}</th>
                <th>{tCles("colonnes.niveau")}</th>
                <th>{tCles("colonnes.depense")}</th>
                <th>{tCles("colonnes.expiration")}</th>
                <th>{tCles("colonnes.statut")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {fiche.activeKeys.map((k) => (
                <tr key={k.requestId}>
                  <td>
                    <code className="text-xs break-all">{k.alias}</code>
                  </td>
                  <td>{k.teamAlias}</td>
                  <td>{domaine(`niveaux.${k.dataLevel}`)}</td>
                  <td>{k.gatewayState ? <DepenseSurBudget spend={k.gatewayState.spend} maxBudget={k.gatewayState.maxBudget} /> : ""}</td>
                  <td>{k.expiresAt ? date(k.expiresAt) : domaine("durees.0")}</td>
                  <td>
                    {domaine(`statuts.${k.status}`)}
                    {k.gatewayState?.blocked && ` · ${cles("bloquee")}`}
                  </td>
                  <td>
                    <ActionsCle cle={k} acteur={acteur} retour={retour} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section aria-labelledby="abonnements">
        <h2 id="abonnements">{t("abonnements")}</h2>
        {fiche.subscriptionsToDeclare.length > 0 && (
          <>
            <h3 className={sousTitre}>{t("abonnementsADeclarer")}</h3>
            <table>
              <thead>
                <tr>
                  <th>{tAbonnements("colonnes.equipe")}</th>
                  <th>{tAbonnements("colonnes.offre")}</th>
                  <th>{tAbonnements("aDeclarer.approuve")}</th>
                  <th>{tAbonnements("aDeclarer.avant")}</th>
                </tr>
              </thead>
              <tbody>
                {fiche.subscriptionsToDeclare.map((d) => (
                  <tr key={d.requestId}>
                    <td>{d.teamAlias}</td>
                    <td>{d.offer}</td>
                    <td>{d.approvedAt ? date(d.approvedAt) : ""}</td>
                    <td>{d.declarationDeadline ? date(d.declarationDeadline) : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        <h3 className={sousTitre}>{tAbonnements("actifs.titre")}</h3>
        {fiche.activeSubscriptions.length === 0 ? (
          <p>{tAbonnements("actifs.aucun")}</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>{tAbonnements("colonnes.equipe")}</th>
                <th>{tAbonnements("colonnes.offre")}</th>
                <th>{tAbonnements("colonnes.compte")}</th>
                <th>{tAbonnements("colonnes.souscrit")}</th>
                <th>{tAbonnements("colonnes.montant")}</th>
                <th>{tAbonnements("colonnes.echeance")}</th>
                <th>{tAbonnements("colonnes.statut")}</th>
                <th>{tAbonnements("colonnes.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {fiche.activeSubscriptions.map((a) => (
                <tr key={a.id}>
                  <td>{a.teamAlias}</td>
                  <td>{a.offer}</td>
                  <td>
                    {a.accountEmail}
                    {a.accountOutsideLinagora && <span className="block text-xs text-amber-800">{tAbonnements("horsLinagora")}</span>}
                  </td>
                  <td>{jour(a.subscribedAt)}</td>
                  <td>{euros(a.monthlyAmountEur)}</td>
                  <td>{jour(a.expiresAt)}</td>
                  <td>
                    {domaine(`statutsAbonnement.${a.status}`)}
                    {a.status === "A_RESILIER" && a.termination && (
                      <span className="block text-xs text-amber-800">
                        {tAbonnements("demande.origine", { origine: a.termination.origin, auteur: a.termination.requestedBy, date: jour(a.termination.requestedAt) })}
                        {a.termination.reason && <span className="block">{tAbonnements("demande.motif", { motif: a.termination.reason })}</span>}
                      </span>
                    )}
                  </td>
                  <td className="space-y-1 text-sm">
                    <ActionsAbonnement abonnement={a} acteur={acteur} retour={retour} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
