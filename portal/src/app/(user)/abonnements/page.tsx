import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { listMySubscriptions } from "@/lib/services/subscriptions";
import { getDeps, requireUser } from "@/lib/session";
import { corrigerMontantAbonnementAction, declarerAbonnementAction, declarerResiliationAction } from "../../actions";
import { ExplicationObligatoires, formats, libelleDuree, Notice } from "../../components";
import { Obligatoire } from "../../obligatoire";

/**
 * Spécification #51, ticket #55 : « Mes abonnements ». Les demandes approuvées à déclarer, chacune avec son formulaire
 * de déclaration (date de souscription, montant prélevé, adresse du compte), puis les abonnements déclarés, dont le
 * titulaire corrige le montant (ticket #57), déclare la résiliation (ticket #58), demande le renouvellement ou le
 * changement d'offre (ticket #59).
 */
export default async function MesAbonnementsPage(props: PageProps<"/abonnements">) {
  const user = await requireUser();
  const [{ euros, jour, date }, t, domaine, searchParams] = await Promise.all([
    formats(),
    getTranslations("mesAbonnements"),
    getTranslations("domaine"),
    props.searchParams,
  ]);
  const { aDeclarer, abonnements } = await listMySubscriptions(getDeps(), user);
  // Jour d'aujourd'hui (AAAA-MM-JJ) : valeur proposée, et date de souscription maximale.
  const aujourdhui = new Date().toISOString().slice(0, 10);

  return (
    <>
      <h1>{t("titre")}</h1>
      <p>{t("introduction")}</p>
      <p>
        <Link href="/catalogue/abonnements">{t("voirOffres")}</Link>
      </p>
      <Notice searchParams={searchParams} />

      {aDeclarer.length > 0 && (
        <section aria-labelledby="a-declarer" className="mt-6">
          <h2 id="a-declarer">{t("aDeclarer.titre")}</h2>
          <ExplicationObligatoires />
          {aDeclarer.map((d) => (
            <article key={d.requestId} aria-labelledby={`declarer-${d.requestId}`} className="mt-4 rounded border border-neutral-200 p-4">
              <h3 id={`declarer-${d.requestId}`} className="mt-0">
                {d.offer} · {d.teamAlias}
              </h3>
              <p className="text-sm">{t("aDeclarer.validite", { duree: libelleDuree(domaine, d.approvedDays) })}</p>
              {d.declarationDeadline && <p className="text-sm">{t("aDeclarer.echeance", { date: date(d.declarationDeadline) })}</p>}
              <form action={declarerAbonnementAction} className="flex flex-wrap items-end gap-3">
                <input type="hidden" name="requestId" value={d.requestId} />
                <label>
                  {t("aDeclarer.date")}
                  <Obligatoire />
                  <input type="date" name="subscribedAt" required max={aujourdhui} defaultValue={aujourdhui} />
                </label>
                <label>
                  {t("aDeclarer.montant")}
                  <Obligatoire />
                  <input type="number" name="monthlyAmountEur" required min="0.01" step="0.01" defaultValue={d.suggestedAmountEur} />
                </label>
                <label>
                  {t("aDeclarer.adresse")}
                  <Obligatoire />
                  <input type="email" name="accountEmail" required defaultValue={user.email} />
                </label>
                <button type="submit">{t("aDeclarer.declarer")}</button>
              </form>
            </article>
          ))}
        </section>
      )}

      <section aria-labelledby="abonnements" className="mt-8">
        <h2 id="abonnements">{t("abonnements")}</h2>
        {abonnements.length === 0 ? (
          <p>{t("aucun")}</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>{t("colonnes.offre")}</th>
                <th>{t("colonnes.equipe")}</th>
                <th>{t("colonnes.compte")}</th>
                <th>{t("colonnes.souscrit")}</th>
                <th>{t("colonnes.montant")}</th>
                <th>{t("colonnes.echeance")}</th>
                <th>{t("colonnes.statut")}</th>
                <th>{t("colonnes.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {abonnements.map((a) => (
                <tr key={a.id}>
                  <td>{a.offer}</td>
                  <td>{a.teamAlias}</td>
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
                        {t("resiliationDemandee", { date: jour(a.termination.requestedAt) })}
                        {a.termination.reason && <span className="block">{t("motif", { motif: a.termination.reason })}</span>}
                      </span>
                    )}
                  </td>
                  <td className="space-y-1 text-sm">
                    {a.pendingRequest && (
                      <p>
                        <Link href="/demandes">{t(a.pendingRequest.type === "RENOUVELLEMENT" ? "renouvellementDemande" : "changementDemande")}</Link>
                      </p>
                    )}
                    {a.canRenew && (
                      <p>
                        <Link href={`/demandes/abonnement?renouveler=${a.id}`}>{t("renouveler")}</Link>
                      </p>
                    )}
                    {a.canChangeOffer && (
                      <p>
                        <Link href={`/demandes/abonnement?changer=${a.id}`}>{t("changerOffre")}</Link>
                      </p>
                    )}
                    {a.status !== "RESILIE" && (
                      <>
                        <details>
                          <summary>{t("correction.ouvrir")}</summary>
                          <form action={corrigerMontantAbonnementAction} aria-label={t("correction.formulaire", { offre: a.offer })}>
                            <input type="hidden" name="subscriptionId" value={a.id} />
                            <label>
                              {t("correction.montant")}
                              <input type="number" name="monthlyAmountEur" required min="0.01" step="0.01" defaultValue={a.monthlyAmountEur} />
                            </label>
                            <p className="text-xs text-neutral-600">{t("correction.aide")}</p>
                            <button type="submit">{t("correction.enregistrer")}</button>
                          </form>
                        </details>
                        <details>
                          <summary>{t("resiliation.ouvrir")}</summary>
                          <form action={declarerResiliationAction} aria-label={t("resiliation.formulaire", { offre: a.offer })}>
                            <input type="hidden" name="subscriptionId" value={a.id} />
                            <label>
                              {t("resiliation.date")}
                              <input type="date" name="terminatedOn" required min={a.subscribedAt.toISOString().slice(0, 10)} max={aujourdhui} defaultValue={aujourdhui} />
                            </label>
                            <p className="text-xs text-neutral-600">{t("resiliation.aide", { fournisseur: a.supplier })}</p>
                            <button type="submit">{t("resiliation.declarer")}</button>
                          </form>
                        </details>
                      </>
                    )}
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
