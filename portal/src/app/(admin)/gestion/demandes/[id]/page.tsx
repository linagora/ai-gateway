import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { PortalError } from "@/lib/errors";
import type { Langue } from "@/lib/langue";
import { modelAcceptsLevel } from "@/lib/policy";
import { getRequestReview } from "@/lib/services/admin-requests";
import { listCatalog } from "@/lib/services/catalog";
import { readSettings } from "@/lib/services/settings";
import { getDeps, requireGestionPage } from "@/lib/session";
import {
  approveKeyRequestAction,
  approveTeamJoinRequestAction,
  refuseRequestAction,
  requestCompletionAction,
} from "../../../../actions";
import { ChoixDuree, ExplicationObligatoires, libelleDuree, Notice, formats } from "../../../../components";
import { Obligatoire } from "../../../../obligatoire";
import { AdminNav } from "../../admin-nav";

/** F-31 / F-32 : fiche d'une demande, contrôles de politique ✔/✘ et décisions. */
export default async function ReviewPage(props: PageProps<"/gestion/demandes/[id]">) {
  const admin = await requireGestionPage();
  const [{ date, euros }, t, domaine, avis, language] = await Promise.all([
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
  const [settings, catalog, teams] = await Promise.all([readSettings(deps.db), listCatalog(deps, language), deps.litellm.listTeams()]);
  // Équipes proposées à la validation : celle de la demande (même si elle a disparu de LiteLLM) et les autres, par nom.
  const equipes = [
    { teamId: review.teamId, teamAlias: review.teamAlias },
    ...teams.filter((team) => team.teamId !== review.teamId).sort((a, b) => a.teamAlias.localeCompare(b.teamAlias, language)),
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
  // Les décisions restent aux admins ; celles d'un responsable arrivent avec le ticket #41.
  const peutDecider = pending && admin.isAdmin;

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
      <dl className="grid grid-cols-[12rem_1fr] gap-x-4 gap-y-1">
        <dt>{t("statut")}</dt>
        <dd>{domaine(`statuts.${review.status}`)}</dd>
        <dt>{t("soumise")}</dt>
        <dd>{date(review.createdAt)}</dd>
        <dt>{t("demandeur")}</dt>
        <dd>
          {review.requesterUid} ({review.requesterEmail})
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
        <dt>{t("motif")}</dt>
        <dd>{review.justification}</dd>
        {review.decisionComment && (
          <>
            <dt>{t("dernierCommentaire")}</dt>
            <dd>{review.decisionComment}</dd>
          </>
        )}
      </dl>

      {review.kind === "CLE" && (
        <>
          <h2>{t("controles")}</h2>
          <ul>
            {review.checks.map((c) => (
              <li key={c.id}>
                {c.ok ? "✔" : "✘"} {avis(`controles.${c.id}`)}
                {c.offending.length > 0 && ` : ${c.offending.join(", ")}`}
              </li>
            ))}
          </ul>
        </>
      )}

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
