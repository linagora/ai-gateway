import { CircleCheck, CircleX } from "lucide-react";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { PortalError } from "@/lib/errors";
import type { Langue } from "@/lib/langue";
import { DUREE_ABONNEMENT_PAR_DEFAUT, DUREES_ABONNEMENT } from "@/lib/durees";
import { modelAcceptsLevel } from "@/lib/policy";
import { getRequestReview } from "@/lib/services/admin-requests";
import { equipesGerees } from "@/lib/services/autorite";
import { listCatalog } from "@/lib/services/catalog";
import { readSettings } from "@/lib/services/settings";
import { getDeps, requireGestionPage } from "@/lib/session";
import {
  approuverAbonnementAction,
  approveKeyRequestAction,
  approveTeamJoinRequestAction,
  refuseRequestAction,
  requestCompletionAction,
} from "../../../../actions";
import { ChoixDuree, ExplicationObligatoires, libelleDuree, Notice, formats } from "../../../../components";
import { Obligatoire } from "../../../../obligatoire";
import { AdminNav } from "../../admin-nav";
import { LienCollaborateur } from "../../lien-collaborateur";

/** F-31 / F-32 : fiche d'une demande, contrôles de politique réussis ou en échec, et décisions. */
export default async function ReviewPage(props: PageProps<"/gestion/demandes/[id]">) {
  const admin = await requireGestionPage();
  const [{ date, euros, jour }, t, domaine, avis, language] = await Promise.all([
    formats(),
    getTranslations("gestion.fiche"),
    getTranslations("domaine"),
    getTranslations("avis"),
    getLocale() as Promise<Langue>,
  ]);
  const { id } = await props.params;
  const searchParams = await props.searchParams;
  const deps = getDeps();
  const review = await getRequestReview(deps, admin, id).catch((e) => {
    if (e instanceof PortalError && e.code === "introuvable") notFound();
    throw e;
  });
  const [settings, catalog, teams, gerees] = await Promise.all([readSettings(deps.db), listCatalog(deps, language), deps.litellm.listTeams(), equipesGerees(deps.db, admin)]);
  // Équipes proposées à la validation : celle de la demande (même si elle a disparu de LiteLLM) et les autres, par nom ;
  // pour un responsable, les seules équipes qu'il gère.
  const equipes = [
    { teamId: review.teamId, teamAlias: review.teamAlias },
    ...teams
      .filter((team) => team.teamId !== review.teamId && (gerees === null || gerees.includes(team.teamId)))
      .sort((a, b) => a.teamAlias.localeCompare(b.teamAlias, language)),
  ];
  const choixEquipe = (libelle: string) => (
    <label>
      {libelle}
      <select name="teamId" defaultValue={review.teamId}>
        {equipes.map((team) => (
          <option key={team.teamId} value={team.teamId}>
            {team.teamAlias}
          </option>
        ))}
      </select>
    </label>
  );
  const pending = review.status === "SOUMISE";
  // Un responsable d'équipe décide des demandes de ses équipes, jamais de la sienne (F-54).
  const sienne = !admin.isAdmin && review.requesterUid === admin.uid;
  const peutDecider = pending && !sienne;

  return (
    <>
      <AdminNav />
      <h1>
        {t("titre", { type: domaine(`typesDemande.${review.kind}`), uid: review.requesterUid })}
      </h1>
      <Notice searchParams={searchParams} />
      {review.renewal && (
        <p className="mb-4 rounded border border-neutral-300 bg-neutral-50 p-3">
          {t("renouvellement", { alias: review.renewal.alias })}
          {review.renewal.spend !== null && ` ${t("depenseOrigine", { depense: euros(review.renewal.spend) })}`}
        </p>
      )}
      {review.renewedSubscription && (
        <p className="mb-4 rounded border border-neutral-300 bg-neutral-50 p-3">
          {t("renouvellementAbonnement", { offre: review.renewedSubscription.offer, echeance: jour(review.renewedSubscription.expiresAt) })}
        </p>
      )}
      {review.replacedSubscription && (
        <p className="mb-4 rounded border border-neutral-300 bg-neutral-50 p-3">{t("changementOffre", { offre: review.replacedSubscription.offer })}</p>
      )}
      <dl className="grid grid-cols-[12rem_1fr] gap-x-4 gap-y-1">
        <dt>{t("statut")}</dt>
        <dd>{domaine(`statuts.${review.status}`)}</dd>
        <dt>{t("soumise")}</dt>
        <dd>{date(review.createdAt)}</dd>
        <dt>{t("demandeur")}</dt>
        <dd>
          <LienCollaborateur uid={review.requesterUid} /> ({review.requesterEmail})
        </dd>
        <dt>{t("equipe")}</dt>
        <dd>{review.teamAlias}</dd>
        {review.kind === "CLE" && (
          <>
            <dt>{t("niveau")}</dt>
            <dd>{review.dataLevel ? domaine(`niveaux.${review.dataLevel}`) : domaine("nonRenseigne")}</dd>
            <dt>{t("modeles")}</dt>
            <dd>{review.models.join(", ")}</dd>
            <dt>{t("projet")}</dt>
            <dd>{review.project ?? domaine("nonRenseigne")}</dd>
            <dt>{t("budgetDuree")}</dt>
            {/* Le budget n'est plus demandé au salarié : seul un renouvellement reprend celui de la clé d'origine. */}
            <dd>
              {[review.requestedBudget !== null ? euros(review.requestedBudget) : null, review.requestedDays !== null ? libelleDuree(domaine, review.requestedDays) : null]
                .filter(Boolean)
                .join(" / ") || domaine("nonRenseigne")}
            </dd>
          </>
        )}
        {review.kind === "ABONNEMENT" && review.subscriptionOffer && (
          <>
            <dt>{t("offre")}</dt>
            <dd>
              {review.subscriptionOffer.name} ({review.subscriptionOffer.supplier})
            </dd>
            <dt>{t("prixMensuel")}</dt>
            <dd>{euros(review.subscriptionOffer.monthlyPriceEur)}</dd>
            <dt>{t("niveauMaximal")}</dt>
            <dd>{domaine(`niveauxOffre.${review.subscriptionOffer.dataLevel}`)}</dd>
            <dt>{t("projet")}</dt>
            <dd>{review.project ?? domaine("nonRenseigne")}</dd>
            <dt>{t("dureeSouhaitee")}</dt>
            <dd>{review.requestedDays !== null ? libelleDuree(domaine, review.requestedDays) : domaine("nonRenseigne")}</dd>
            {review.approvedDays !== null && (
              <>
                <dt>{t("validiteAccordee")}</dt>
                <dd>{libelleDuree(domaine, review.approvedDays)}</dd>
              </>
            )}
          </>
        )}
        <dt>{t("motif")}</dt>
        <dd>{review.justification}</dd>
        {review.decisionComment && (
          <>
            <dt>{t("dernierCommentaire")}</dt>
            <dd>{review.decisionComment}</dd>
          </>
        )}
      </dl>

      {review.kind === "ABONNEMENT" && (
        <section aria-labelledby="abonnements-en-cours">
          <h2 id="abonnements-en-cours">{t("abonnementsEnCours")}</h2>
          {review.requesterSubscriptions.length === 0 ? (
            <p>{t("aucunAbonnement")}</p>
          ) : (
            <ul>
              {review.requesterSubscriptions.map((a, i) => (
                <li key={i}>
                  {a.offer} · {a.teamAlias} · {t("depuis", { date: jour(a.subscribedAt) })} · {t("parMois", { montant: euros(a.monthlyAmountEur) })}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {review.kind === "CLE" && (
        <>
          <h2>{t("controles")}</h2>
          <ul>
            {review.checks.map((c) => (
              <li key={c.id} className="flex items-start gap-2">
                {c.ok ? (
                  <CircleCheck aria-hidden="true" className="mt-1 size-4 shrink-0 text-green-700" />
                ) : (
                  <CircleX aria-hidden="true" className="mt-1 size-4 shrink-0 text-red-700" />
                )}
                <span>
                  <span className="sr-only">{t(c.ok ? "controleReussi" : "controleEchoue")} : </span>
                  {avis(`controles.${c.id}`)}
                  {c.offending.length > 0 && ` : ${c.offending.join(", ")}`}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      {pending && sienne && <p className="mt-6 rounded border border-neutral-300 bg-neutral-50 p-3">{t("propreDemande")}</p>}

      {peutDecider && <ExplicationObligatoires />}

      {peutDecider && review.kind === "CLE" && (
        <>
          <h2>{t("approuverCle")}</h2>
          <form action={approveKeyRequestAction}>
            <input type="hidden" name="id" value={review.id} />
            {choixEquipe(t("equipeCle"))}
            <p className="text-sm text-neutral-600">{t("aideEquipe")}</p>
            <fieldset>
              <legend className="font-medium">
                {t("modelesAccordes")}
                <Obligatoire />
              </legend>
              {catalog
                .filter((m) => review.dataLevel && modelAcceptsLevel(m.dataLevel, review.dataLevel))
                .map((m) => (
                  <label key={m.modelName} className="font-normal">
                    <input type="checkbox" name="models" value={m.modelName} defaultChecked={review.models.includes(m.modelName)} /> {m.displayName}{" "}
                    ({domaine(`niveaux.${m.dataLevel}`)})
                  </label>
                ))}
            </fieldset>
            <label>
              {t("budget")}
              <input name="budget" type="number" min="0.01" step="0.01" defaultValue={review.requestedBudget ?? settings.default_budget ?? ""} />
            </label>
            <label>
              {t("periode")}
              <input name="budgetDuration" defaultValue={settings.default_budget_duration ?? ""} />
            </label>
            <label>
              {t("validite")}
              <ChoixDuree name="days" valeur={review.requestedDays ?? (settings.default_days ? Number(settings.default_days) : null)} />
            </label>
            <label>
              {t("rpm")}
              <input name="rpmLimit" type="number" min="1" step="1" defaultValue={settings.default_rpm ?? ""} />
            </label>
            <label>
              {t("tpm")}
              <input name="tpmLimit" type="number" min="1" step="1" defaultValue={settings.default_tpm ?? ""} />
            </label>
            <button type="submit">{t("approuver")}</button>
          </form>
        </>
      )}

      {peutDecider && review.kind === "ABONNEMENT" && (
        <>
          <h2>{t("approuverAbonnement")}</h2>
          <form action={approuverAbonnementAction}>
            <input type="hidden" name="id" value={review.id} />
            <label>
              {t("validite")}
              <select name="days" defaultValue={review.requestedDays ?? DUREE_ABONNEMENT_PAR_DEFAUT}>
                {DUREES_ABONNEMENT.map((jours) => (
                  <option key={jours} value={jours}>
                    {libelleDuree(domaine, jours)}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit">{t("approuver")}</button>
          </form>
        </>
      )}

      {peutDecider && review.kind === "ADHESION_EQUIPE" && (
        <form action={approveTeamJoinRequestAction}>
          <input type="hidden" name="id" value={review.id} />
          {choixEquipe(t("equipeAffectation"))}
          <button type="submit">{t("approuverAdhesion", { uid: review.requesterUid })}</button>
        </form>
      )}

      {peutDecider && (
        <>
          <h2>{t("refuserOuCompleter")}</h2>
          <form action={refuseRequestAction}>
            <input type="hidden" name="id" value={review.id} />
            <label>
              {t("motifRefus")}
              <Obligatoire />
              <textarea name="comment" required rows={2} />
            </label>
            <button type="submit">{t("refuser")}</button>
          </form>
          <form action={requestCompletionAction}>
            <input type="hidden" name="id" value={review.id} />
            <label>
              {t("complement")}
              <textarea name="comment" rows={2} />
            </label>
            <button type="submit">{t("demanderComplement")}</button>
          </form>
        </>
      )}
    </>
  );
}
