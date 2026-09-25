import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import type { Langue } from "@/lib/langue";
import { DATA_LEVELS } from "@/lib/policy";
import { listCatalog } from "@/lib/services/catalog";
import { renewalDraft } from "@/lib/services/keys";
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
  const [t, domaine, catalogue, language, searchParams] = await Promise.all([
    getTranslations("nouvelleDemande"),
    getTranslations("domaine"),
    getTranslations("catalogue"),
    getLocale() as Promise<Langue>,
    props.searchParams,
  ]);
  const completing = typeof searchParams.completer === "string" ? searchParams.completer : "";
  // Préremplissage depuis le catalogue : niveau de la page et modèles sélectionnés. Ce ne sont que des
  // valeurs proposées : les contrôles de la demande restent ceux du serveur.
  const deps = getDeps();
  // Renouvellement (?renouvelle=<demande>) : la demande reprend les paramètres de la clé d'origine.
  const renouvellement =
    typeof searchParams.renouvelle === "string" ? await renewalDraft(deps, user, searchParams.renouvelle).catch(() => null) : null;
  const niveau = renouvellement?.dataLevel ?? DATA_LEVELS.find((l) => l === searchParams.niveau) ?? null;
  const preselected = renouvellement?.models ?? [searchParams.modeles].flat().filter((m): m is string => typeof m === "string");
  const [teams, catalog] = await Promise.all([listMyTeams(deps, user), listCatalog(deps, language)]);

  return (
    <>
      <h1>{completing ? t("titreCompleter") : renouvellement ? t("titreRenouvellement", { alias: renouvellement.alias }) : t("titre")}</h1>
      <Notice searchParams={searchParams} />
      {teams.length === 0 ? (
        <p>
          {t("aucuneEquipe")} <Link href="/demandes/adhesion">{t("rejoindreDabord")}</Link>
        </p>
      ) : (
        <form action={createKeyRequestAction}>
          {completing && <input type="hidden" name="requestId" value={completing} />}
          {renouvellement && <input type="hidden" name="renewsRequestId" value={String(searchParams.renouvelle)} />}
          <label>
            {t("equipe")}
            <select name="teamId" required defaultValue={renouvellement?.teamId}>
              {teams.map((team) => (
                <option key={team.teamId} value={team.teamId}>
                  {team.teamAlias}
                </option>
              ))}
            </select>
          </label>
          <p className="text-sm">
            {t("equipeAbsente")} <Link href="/demandes/adhesion">{t("rejoindre")}</Link>
          </p>
          <fieldset>
            <legend className="font-medium">{t("niveau")}</legend>
            {DATA_LEVELS.map((l) => (
              <label key={l} className="font-normal">
                <input type="radio" name="dataLevel" value={l} required defaultChecked={l === niveau} /> {domaine(`niveaux.${l}`)} —{" "}
                {catalogue(`niveaux.${l}.definition`)}
              </label>
            ))}
          </fieldset>
          <fieldset>
            <legend className="font-medium">{t("modeles")}</legend>
            {catalog.map((m) => (
              <label key={m.modelName} className="font-normal">
                <input type="checkbox" name="models" value={m.modelName} defaultChecked={preselected.includes(m.modelName)} /> {m.displayName} (
                {domaine(`niveaux.${m.dataLevel}`)})
              </label>
            ))}
          </fieldset>
          <label>
            {t("motif")}
            <textarea name="justification" required rows={3} />
          </label>
          <label>
            {t("projet")}
            <input name="project" defaultValue={renouvellement?.project ?? ""} />
          </label>
          <label>
            {t("budget")}
            <input name="requestedBudget" type="number" min="1" step="1" defaultValue={renouvellement?.requestedBudget ?? ""} />
          </label>
          <label>
            {t("duree")}
            <input name="requestedDays" type="number" min="1" step="1" defaultValue={renouvellement?.requestedDays ?? ""} />
          </label>
          <label>
            {t("typeCle")}
            <select name="keyType" defaultValue={renouvellement?.keyType}>
              <option value="PERSONNELLE">{domaine("typesCle.PERSONNELLE")}</option>
              <option value="SERVICE">{domaine("typesCle.SERVICE")}</option>
            </select>
          </label>
          <label className="font-normal">
            <input type="checkbox" name="commitment" required /> {t("engagement")}
          </label>
          <button type="submit">{completing ? t("resoumettre") : t("envoyer")}</button>
        </form>
      )}
    </>
  );
}
