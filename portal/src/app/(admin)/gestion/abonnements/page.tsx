import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { PortalError } from "@/lib/errors";
import { type AdminSubscription, listActiveSubscriptions, listSubscriptionArchive, listSubscriptionsToDeclare } from "@/lib/services/subscriptions";
import { getTeamOverview } from "@/lib/services/teams";
import { getDeps, requireGestionPage } from "@/lib/session";
import { formats, Notice, PaginationArchive } from "../../../components";
import { ActionsAbonnement } from "../actions-gestion";
import { AdminNav } from "../admin-nav";
import { LienCollaborateur } from "../lien-collaborateur";

/**
 * Spécification #51, ticket #56 : les abonnements approuvés en attente de déclaration, les abonnements actifs, puis
 * l'archive des abonnements résiliés, page par page ; pour un responsable, ceux de ses équipes. Avec `?equipe=`, la
 * page se limite aux abonnements de cette équipe. Chaque abonnement montre ses prélèvements (ticket #57) ; un abonnement
 * actif se voit demander sa résiliation, et un admin déclare une résiliation à la place du titulaire (ticket #58).
 */
export default async function GestionAbonnementsPage(props: PageProps<"/gestion/abonnements">) {
  const acteur = await requireGestionPage();
  const [{ date, euros, jour }, t, domaine, searchParams] = await Promise.all([
    formats(),
    getTranslations("gestion.abonnements"),
    getTranslations("domaine"),
    props.searchParams,
  ]);
  const teamId = typeof searchParams.equipe === "string" ? searchParams.equipe : undefined;
  // Une équipe inconnue, ou hors de l'autorité d'un responsable, est introuvable.
  const equipe = teamId
    ? await getTeamOverview(getDeps(), acteur, teamId).catch((e: unknown) => {
        if (e instanceof PortalError && e.code === "introuvable") notFound();
        throw e;
      })
    : null;
  const [aDeclarer, actifs, archive] = await Promise.all([
    listSubscriptionsToDeclare(getDeps(), acteur, { equipe: teamId }),
    listActiveSubscriptions(getDeps(), acteur, { equipe: teamId }),
    listSubscriptionArchive(getDeps(), acteur, Number(searchParams.page) || 1, { equipe: teamId }),
  ]);
  const titulaire = (uid: string, email: string) => (
    <td>
      <LienCollaborateur uid={uid} />
      <br />
      <span className="text-xs text-neutral-600">{email}</span>
    </td>
  );
  /** Demander la résiliation d'un abonnement actif ; pour un admin, déclarer la résiliation à la place du titulaire. */
  const actions = (a: AdminSubscription) => (
    <td className="space-y-1 text-sm">
      <ActionsAbonnement abonnement={a} acteur={acteur} retour={{ equipe: teamId }} />
    </td>
  );
  /** Ligne d'un abonnement ; celles des abonnements actifs ou à résilier ont leurs actions. */
  const ligne = (a: AdminSubscription, avecActions: boolean) => (
    <tr key={a.id}>
      {titulaire(a.holderUid, a.holderEmail)}
      <td>{a.teamAlias}</td>
      <td>{a.offer}</td>
      <td>
        {a.accountEmail}
        {a.accountOutsideLinagora && <span className="block text-xs text-amber-800">{t("horsLinagora")}</span>}
      </td>
      <td>{jour(a.subscribedAt)}</td>
      <td>{euros(a.monthlyAmountEur)}</td>
      <td>{jour(a.expiresAt)}</td>
      <td>
        {a.status === "RESILIE" && a.terminatedOn ? t("resilieLe", { date: jour(a.terminatedOn) }) : domaine(`statutsAbonnement.${a.status}`)}
        {a.status === "A_RESILIER" && a.termination && (
          <span className="block text-xs text-amber-800">
            {t("demande.origine", { origine: a.termination.origin, auteur: a.termination.requestedBy, date: jour(a.termination.requestedAt) })}
            {a.termination.reason && <span className="block">{t("demande.motif", { motif: a.termination.reason })}</span>}
          </span>
        )}
      </td>
      <td>
        {a.charges.length === 0 ? (
          t("prelevements.aucun")
        ) : (
          <details>
            <summary>{t("prelevements.resume", { nombre: a.charges.length, total: euros(a.charges.reduce((total, c) => total + c.amountEur, 0)) })}</summary>
            <ul className="mt-1 text-xs">
              {a.charges.map((c) => (
                <li key={c.chargedOn.toISOString()}>{t("prelevements.ligne", { date: jour(c.chargedOn), montant: euros(c.amountEur), equipe: c.teamAlias })}</li>
              ))}
            </ul>
          </details>
        )}
      </td>
      {avecActions && actions(a)}
    </tr>
  );
  const entetes = (avecActions: boolean) => (
    <tr>
      <th>{t("colonnes.titulaire")}</th>
      <th>{t("colonnes.equipe")}</th>
      <th>{t("colonnes.offre")}</th>
      <th>{t("colonnes.compte")}</th>
      <th>{t("colonnes.souscrit")}</th>
      <th>{t("colonnes.montant")}</th>
      <th>{t("colonnes.echeance")}</th>
      <th>{t("colonnes.statut")}</th>
      <th>{t("colonnes.prelevements")}</th>
      {avecActions && <th>{t("colonnes.actions")}</th>}
    </tr>
  );

  return (
    <>
      <AdminNav />
      <h1>{t("titre")}</h1>
      {equipe && (
        <p className="flex flex-wrap items-center gap-3">
          <span>{t("filtreEquipe", { equipe: equipe.teamAlias })}</span>
          <Link href="/gestion/abonnements">{t("tous")}</Link>
        </p>
      )}
      <Notice searchParams={searchParams} />

      {aDeclarer.length > 0 && (
        <section aria-labelledby="a-declarer">
          <h2 id="a-declarer">{t("aDeclarer.titre")}</h2>
          <table>
            <thead>
              <tr>
                <th>{t("colonnes.titulaire")}</th>
                <th>{t("colonnes.equipe")}</th>
                <th>{t("colonnes.offre")}</th>
                <th>{t("aDeclarer.approuve")}</th>
                <th>{t("aDeclarer.avant")}</th>
              </tr>
            </thead>
            <tbody>
              {aDeclarer.map((d) => (
                <tr key={d.requestId}>
                  {titulaire(d.holderUid, d.holderEmail)}
                  <td>{d.teamAlias}</td>
                  <td>{d.offer}</td>
                  <td>{d.approvedAt ? date(d.approvedAt) : ""}</td>
                  <td>{d.declarationDeadline ? date(d.declarationDeadline) : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section aria-labelledby="actifs">
        <h2 id="actifs">{t("actifs.titre")}</h2>
        {actifs.length === 0 ? (
          <p>{t("actifs.aucun")}</p>
        ) : (
          <table>
            <thead>{entetes(true)}</thead>
            <tbody>{actifs.map((a) => ligne(a, true))}</tbody>
          </table>
        )}
      </section>

      <section aria-labelledby="archive-abonnements" className="mt-10">
        <h2 id="archive-abonnements">{t("archive.titre")}</h2>
        {archive.total === 0 ? (
          <p>{t("archive.aucune")}</p>
        ) : (
          <table>
            <thead>{entetes(false)}</thead>
            <tbody>{archive.elements.map((a) => ligne(a, false))}</tbody>
          </table>
        )}
        <PaginationArchive
          archive={archive}
          lien={(page) => `/gestion/abonnements?${teamId ? `equipe=${encodeURIComponent(teamId)}&` : ""}page=${page}`}
          libelles={{
            pagination: t("archive.pagination"),
            position: t("archive.position", { page: archive.page, pages: archive.pages, total: archive.total }),
            plusRecentes: t("archive.plusRecentes"),
            plusAnciennes: t("archive.plusAnciennes"),
          }}
        />
      </section>
    </>
  );
}
