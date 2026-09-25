import Link from "next/link";
import { LEVEL_DESCRIPTIONS, LEVEL_LABELS } from "@/lib/labels";
import { DATA_LEVELS } from "@/lib/policy";
import { listCatalog } from "@/lib/services/catalog";
import { listMyTeams } from "@/lib/services/requests";
import { getDeps, requireUser } from "@/lib/session";
import { createKeyRequestAction } from "../../../actions";
import { Notice } from "../../../components";

/**
 * F-20 / F-21 : demande de clé (ou complément d'une demande renvoyée : ?completer=<id>).
 * V1 : tous les modèles visibles sont proposés ; le serveur rejoue les contrôles (équipe, niveau).
 * Le filtrage dynamique des modèles selon l'équipe et le niveau relève de la reprise de l'ergonomie.
 */
export default async function NewRequestPage(props: PageProps<"/demandes/nouvelle">) {
  const user = await requireUser();
  const searchParams = await props.searchParams;
  const completing = typeof searchParams.completer === "string" ? searchParams.completer : "";
  const preselected = typeof searchParams.modele === "string" ? searchParams.modele : "";
  const deps = getDeps();
  const [teams, catalog] = await Promise.all([listMyTeams(deps, user), listCatalog(deps)]);

  return (
    <>
      <h1>{completing ? "Compléter ma demande" : "Demander une clé d'API"}</h1>
      <Notice searchParams={searchParams} />
      {teams.length === 0 ? (
        <p>
          Vous n&apos;êtes membre d&apos;aucune équipe. <Link href="/demandes/adhesion">Demandez d&apos;abord à rejoindre une équipe.</Link>
        </p>
      ) : (
        <form action={createKeyRequestAction}>
          {completing && <input type="hidden" name="requestId" value={completing} />}
          <label>
            Équipe
            <select name="teamId" required>
              {teams.map((t) => (
                <option key={t.teamId} value={t.teamId}>
                  {t.teamAlias}
                </option>
              ))}
            </select>
          </label>
          <p className="text-sm">
            Votre équipe n&apos;est pas listée ? <Link href="/demandes/adhesion">Demander à la rejoindre</Link>
          </p>
          <fieldset>
            <legend className="font-medium">Niveau de sensibilité des données que vous traiterez</legend>
            {DATA_LEVELS.map((l) => (
              <label key={l} className="font-normal">
                <input type="radio" name="dataLevel" value={l} required /> {LEVEL_LABELS[l]} — {LEVEL_DESCRIPTIONS[l]}
              </label>
            ))}
          </fieldset>
          <fieldset>
            <legend className="font-medium">Modèles (niveau maximal accepté par chaque modèle)</legend>
            {catalog.map((m) => (
              <label key={m.modelName} className="font-normal">
                <input type="checkbox" name="models" value={m.modelName} defaultChecked={m.modelName === preselected} /> {m.displayName} (
                {LEVEL_LABELS[m.dataLevel]})
              </label>
            ))}
          </fieldset>
          <label>
            Motif
            <textarea name="justification" required rows={3} />
          </label>
          <label>
            Projet ou affaire
            <input name="project" />
          </label>
          <label>
            Budget souhaité (€)
            <input name="requestedBudget" type="number" min="1" step="1" />
          </label>
          <label>
            Durée souhaitée (jours)
            <input name="requestedDays" type="number" min="1" step="1" />
          </label>
          <label>
            Type de clé
            <select name="keyType">
              <option value="PERSONNELLE">Personnelle</option>
              <option value="SERVICE">Service (application)</option>
            </select>
          </label>
          <label className="font-normal">
            <input type="checkbox" name="commitment" required /> Je m&apos;engage à ne pas soumettre de données d&apos;un niveau supérieur à
            celui déclaré (niveau Expérimental : données publiques uniquement).
          </label>
          <button type="submit">{completing ? "Resoumettre" : "Envoyer la demande"}</button>
        </form>
      )}
    </>
  );
}
