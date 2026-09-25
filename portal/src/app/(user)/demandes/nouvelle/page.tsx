import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import type { Langue } from "@/lib/langue";
import { DATA_LEVELS } from "@/lib/policy";
import { listCatalog } from "@/lib/services/catalog";
import { renewalDraft } from "@/lib/services/keys";
import { listMyTeams } from "@/lib/services/requests";
import { readSettings } from "@/lib/services/settings";
import { getDeps, requireUser } from "@/lib/session";
import { createKeyRequestAction } from "../../../actions";
import { ChoixDuree, ExplicationObligatoires, Notice } from "../../../components";
import { Obligatoire } from "../../../obligatoire";
import { NiveauEtModeles } from "./niveau-et-modeles";

/**
 * F-20 / F-21 : demande de clé (ou complément d'une demande renvoyée : ?completer=<id>).
 * Seuls les modèles qui acceptent le niveau choisi sont proposés ; le serveur rejoue les contrôles (équipe, niveau).
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
  const [teams, catalog, settings] = await Promise.all([listMyTeams(deps, user), listCatalog(deps, language), readSettings(deps.db)]);
  const dureeParDefaut = settings.default_days ? Number(settings.default_days) : null;

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
          <ExplicationObligatoires />
          <label>
            {t("equipe")}
            <Obligatoire />
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
          <NiveauEtModeles
            niveaux={DATA_LEVELS.map((l) => ({ niveau: l, libelle: domaine(`niveaux.${l}`), definition: catalogue(`niveaux.${l}.definition`) }))}
            modeles={catalog.map((m) => ({ modelName: m.modelName, displayName: m.displayName, dataLevel: m.dataLevel, libelleNiveau: domaine(`niveaux.${m.dataLevel}`) }))}
            niveauInitial={niveau}
            preselection={preselected}
            textes={{ niveau: t("niveau"), modeles: t("modeles"), choisirNiveau: t("choisirNiveau"), aucunModele: t("aucunModeleNiveau") }}
          />
          <label>
            {t("motif")}
            <Obligatoire />
            <textarea name="justification" required rows={3} />
          </label>
          <label>
            {t("projet")}
            <input name="project" defaultValue={renouvellement?.project ?? ""} />
          </label>
          {/* Le budget n'est plus demandé au salarié : l'admin le fixe ; un renouvellement propose celui de la clé d'origine. */}
          {renouvellement?.requestedBudget != null && <input type="hidden" name="requestedBudget" value={renouvellement.requestedBudget} />}
          <label>
            {t("duree")}
            <ChoixDuree name="requestedDays" valeur={renouvellement?.requestedDays ?? dureeParDefaut} />
          </label>
          <label className="font-normal">
            <input type="checkbox" name="commitment" required /> {t("engagement")}
            <Obligatoire />
          </label>
          <button type="submit">{completing ? t("resoumettre") : t("envoyer")}</button>
        </form>
      )}
    </>
  );
}
