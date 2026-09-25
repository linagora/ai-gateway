import { notFound } from "next/navigation";
import { PortalError } from "@/lib/errors";
import { CHECK_LABELS, KIND_LABELS, LEVEL_LABELS, STATUS_LABELS } from "@/lib/labels";
import { getRequestReview } from "@/lib/services/admin-requests";
import { listCatalog } from "@/lib/services/catalog";
import { readSettings } from "@/lib/services/settings";
import { getDeps, requireAdminPage } from "@/lib/session";
import {
  approveKeyRequestAction,
  approveTeamJoinRequestAction,
  refuseRequestAction,
  requestCompletionAction,
} from "../../../../actions";
import { Notice, formats } from "../../../../components";
import { AdminNav } from "../../admin-nav";

/** F-31 / F-32 : fiche d'une demande, contrôles de politique ✔/✘ et décisions. */
export default async function ReviewPage(props: PageProps<"/gestion/demandes/[id]">) {
  const admin = await requireAdminPage();
  const { date, euros } = await formats();
  const { id } = await props.params;
  const searchParams = await props.searchParams;
  const deps = getDeps();
  const review = await getRequestReview(deps, admin, id).catch((e) => {
    if (e instanceof PortalError && e.code === "introuvable") notFound();
    throw e;
  });
  const [settings, catalog] = await Promise.all([readSettings(deps.db), listCatalog(deps)]);
  const pending = review.status === "SOUMISE";

  return (
    <>
      <AdminNav />
      <h1>
        {KIND_LABELS[review.kind]} — {review.requesterUid}
      </h1>
      <Notice searchParams={searchParams} />
      <dl className="grid grid-cols-[12rem_1fr] gap-x-4 gap-y-1">
        <dt>Statut</dt>
        <dd>{STATUS_LABELS[review.status]}</dd>
        <dt>Soumise le</dt>
        <dd>{date(review.createdAt)}</dd>
        <dt>Demandeur</dt>
        <dd>
          {review.requesterUid} ({review.requesterEmail})
        </dd>
        <dt>Équipe</dt>
        <dd>{review.teamAlias}</dd>
        {review.kind === "CLE" && (
          <>
            <dt>Niveau déclaré</dt>
            <dd>{review.dataLevel ? LEVEL_LABELS[review.dataLevel] : "—"}</dd>
            <dt>Modèles demandés</dt>
            <dd>{review.models.join(", ")}</dd>
            <dt>Projet</dt>
            <dd>{review.project ?? "—"}</dd>
            <dt>Type de clé</dt>
            <dd>{review.keyType ?? "—"}</dd>
            <dt>Budget / durée souhaités</dt>
            <dd>
              {euros(review.requestedBudget)} / {review.requestedDays ? `${review.requestedDays} jours` : "—"}
            </dd>
          </>
        )}
        <dt>Motif</dt>
        <dd>{review.justification}</dd>
        {review.decisionComment && (
          <>
            <dt>Dernier commentaire</dt>
            <dd>{review.decisionComment}</dd>
          </>
        )}
      </dl>

      {review.kind === "CLE" && (
        <>
          <h2>Contrôles de politique (état actuel)</h2>
          <ul>
            {review.checks.map((c) => (
              <li key={c.id}>
                {c.ok ? "✔" : "✘"} {CHECK_LABELS[c.id]}
                {c.offending.length > 0 && ` : ${c.offending.join(", ")}`}
              </li>
            ))}
          </ul>
        </>
      )}

      {pending && review.kind === "CLE" && (
        <>
          <h2>Approuver (paramètres de la clé)</h2>
          <form action={approveKeyRequestAction}>
            <input type="hidden" name="id" value={review.id} />
            <fieldset>
              <legend className="font-medium">Modèles accordés</legend>
              {catalog.map((m) => (
                <label key={m.modelName} className="font-normal">
                  <input type="checkbox" name="models" value={m.modelName} defaultChecked={review.models.includes(m.modelName)} /> {m.displayName}{" "}
                  ({LEVEL_LABELS[m.dataLevel]})
                </label>
              ))}
            </fieldset>
            <label>
              Budget (€)
              <input name="budget" type="number" min="0.01" step="0.01" defaultValue={review.requestedBudget ?? settings.default_budget ?? ""} />
            </label>
            <label>
              Période du budget (ex. 30d)
              <input name="budgetDuration" defaultValue={settings.default_budget_duration ?? ""} />
            </label>
            <label>
              Durée de validité (jours)
              <input name="days" type="number" min="1" step="1" defaultValue={review.requestedDays ?? settings.default_days ?? ""} />
            </label>
            <label>
              Limite de requêtes par minute (facultatif)
              <input name="rpmLimit" type="number" min="1" step="1" defaultValue={settings.default_rpm ?? ""} />
            </label>
            <label>
              Limite de jetons par minute (facultatif)
              <input name="tpmLimit" type="number" min="1" step="1" defaultValue={settings.default_tpm ?? ""} />
            </label>
            <button type="submit">Approuver</button>
          </form>
        </>
      )}

      {pending && review.kind === "ADHESION_EQUIPE" && (
        <form action={approveTeamJoinRequestAction}>
          <input type="hidden" name="id" value={review.id} />
          <button type="submit">Approuver : ajouter {review.requesterUid} à l&apos;équipe {review.teamAlias}</button>
        </form>
      )}

      {pending && (
        <>
          <h2>Refuser ou demander un complément</h2>
          <form action={refuseRequestAction}>
            <input type="hidden" name="id" value={review.id} />
            <label>
              Motif du refus (obligatoire)
              <textarea name="comment" required rows={2} />
            </label>
            <button type="submit">Refuser</button>
          </form>
          <form action={requestCompletionAction}>
            <input type="hidden" name="id" value={review.id} />
            <label>
              Complément demandé
              <textarea name="comment" rows={2} />
            </label>
            <button type="submit">Demander un complément</button>
          </form>
        </>
      )}
    </>
  );
}
