import type { SessionUser } from "@/lib/auth-user";
import type { Db } from "@/lib/db";
import { PortalError } from "@/lib/errors";
import type { LiteLLMClient, LiteLLMTeam } from "@/lib/litellm/client";
import { requireAdmin } from "@/lib/rbac";
import { recordAudit } from "./audit";
import { type NotificationDeps, notifyTeamChange } from "./notifications";

/** Dépendances du service des équipes (F-53) : LiteLLM, source de vérité des équipes, et la base du portail. */
export interface TeamDeps extends NotificationDeps {
  db: Db;
  litellm: LiteLLMClient;
}

/** Équipe telle que la présente la gestion : ses membres réels et ses clés actives émises par le portail. */
export interface TeamOverview {
  teamId: string;
  teamAlias: string;
  memberCount: number;
  activeKeyCount: number;
}

/** Longueur maximale d'un nom d'équipe. */
const NOM_MAX = 100;

/** F-53 : toutes les équipes, par ordre alphabétique, avec leurs membres réels et leurs clés actives. */
export async function listTeamOverviews(deps: TeamDeps, actor: SessionUser): Promise<TeamOverview[]> {
  requireAdmin(actor);
  const teams = await deps.litellm.listTeams();
  const cles = await activeKeyCounts(deps.db);
  return teams.map((t) => overview(t, cles)).sort((a, b) => a.teamAlias.localeCompare(b.teamAlias, "fr"));
}

/** F-53 : une équipe ; introuvable si LiteLLM ne la connaît pas. */
export async function getTeamOverview(deps: TeamDeps, actor: SessionUser, teamId: string): Promise<TeamOverview> {
  requireAdmin(actor);
  return overview(await existingTeam(deps, teamId), await activeKeyCounts(deps.db));
}

/** F-53 : crée une équipe (nom unique sans tenir compte des majuscules), l'inscrit au journal et l'annonce aux admins. */
export async function createTeam(deps: TeamDeps, actor: SessionUser, input: { name: string }): Promise<string> {
  requireAdmin(actor);
  const nom = await nomLibre(deps, input.name, null);
  const teamId = await deps.litellm.createTeam(nom);
  await recordAudit(deps.db, { actorUid: actor.uid, action: "TEAM_CREATED", targetId: teamId, details: { equipe: nom } });
  await notifyTeamChange(deps, { type: "creee", teamId, equipe: nom, auteur: actor });
  return teamId;
}

/** F-53 : renomme une équipe ; les clés gardent leur alias et l'historique des demandes l'ancien nom. */
export async function renameTeam(deps: TeamDeps, actor: SessionUser, input: { teamId: string; name: string }): Promise<void> {
  requireAdmin(actor);
  const team = await existingTeam(deps, input.teamId);
  const nom = await nomLibre(deps, input.name, team.teamId);
  if (nom === team.teamAlias) return;
  await deps.litellm.updateTeam(team.teamId, { alias: nom });
  await recordAudit(deps.db, { actorUid: actor.uid, action: "TEAM_RENAMED", targetId: team.teamId, details: { ancienNom: team.teamAlias, nouveauNom: nom } });
  await notifyTeamChange(deps, { type: "renommee", teamId: team.teamId, equipe: nom, ancienNom: team.teamAlias, auteur: actor });
}

async function existingTeam(deps: TeamDeps, teamId: string): Promise<LiteLLMTeam> {
  const team = await deps.litellm.getTeam(teamId);
  if (!team) throw new PortalError("introuvable", `Équipe introuvable : ${teamId}.`, { objet: "equipe" });
  return team;
}

/** Nom d'équipe valide et libre : non vide, sans espaces autour, pas déjà pris par une autre équipe aux majuscules près. */
async function nomLibre(deps: TeamDeps, saisi: string, teamId: string | null): Promise<string> {
  const nom = saisi.trim();
  if (!nom || nom.length > NOM_MAX) throw new PortalError("nom_equipe_invalide", "Nom d'équipe vide ou trop long.");
  const minuscules = nom.toLocaleLowerCase("fr");
  const homonyme = (await deps.litellm.listTeams()).find((t) => t.teamId !== teamId && t.teamAlias.toLocaleLowerCase("fr") === minuscules);
  if (homonyme) throw new PortalError("nom_equipe_pris", `Nom déjà pris : ${homonyme.teamAlias}.`, { nom: homonyme.teamAlias });
  return nom;
}

/** Clés émises par le portail et encore actives, par équipe. */
async function activeKeyCounts(db: Db): Promise<Map<string, number>> {
  const groupes = await db.accessRequest.groupBy({ by: ["teamId"], where: { kind: "CLE", status: "CLE_EMISE" }, _count: { _all: true } });
  return new Map(groupes.map((g) => [g.teamId, g._count._all]));
}

function overview(team: LiteLLMTeam, cles: Map<string, number>): TeamOverview {
  return { teamId: team.teamId, teamAlias: team.teamAlias, memberCount: team.memberUids.length, activeKeyCount: cles.get(team.teamId) ?? 0 };
}
