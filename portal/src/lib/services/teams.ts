import type { SessionUser } from "@/lib/auth-user";
import type { Db } from "@/lib/db";
import { PortalError } from "@/lib/errors";
import type { LiteLLMClient, LiteLLMTeam } from "@/lib/litellm/client";
import { requireAdmin } from "@/lib/rbac";
import { recordAudit } from "./audit";
import { revokeMemberKeys } from "./keys";
import { type NotificationDeps, notifyMemberAdded, notifyMemberRemoved, notifyTeamChange } from "./notifications";
import { cancelMemberRequests } from "./requests";

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

/** Page d'une équipe : son résumé et ses membres réels, par ordre alphabétique. */
export interface TeamPage extends TeamOverview {
  members: string[];
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

/** F-53 : page d'une équipe ; introuvable si LiteLLM ne la connaît pas. */
export async function getTeamPage(deps: TeamDeps, actor: SessionUser, teamId: string): Promise<TeamPage> {
  requireAdmin(actor);
  const team = await existingTeam(deps, teamId);
  return { ...overview(team, await activeKeyCounts(deps.db)), members: [...team.memberUids].sort((a, b) => a.localeCompare(b, "fr")) };
}

/**
 * F-53 : ajout direct d'un salarié à une équipe par un admin (affectation initiale, sans demande d'accès). Le salarié
 * doit s'être connecté au moins une fois au portail, qui l'a alors inscrit dans LiteLLM.
 */
export async function addTeamMember(deps: TeamDeps, actor: SessionUser, input: { teamId: string; uid: string }): Promise<void> {
  requireAdmin(actor);
  const team = await existingTeam(deps, input.teamId);
  const uid = input.uid.trim();
  const salarie = uid ? await deps.litellm.getUser(uid) : null;
  if (!salarie) throw new PortalError("salarie_inconnu", `Salarié inconnu de la passerelle : ${uid}.`, { uid });
  if (team.memberUids.includes(uid)) throw new PortalError("membre_existant", `${uid} est déjà membre de ${team.teamAlias}.`, { uid, equipe: team.teamAlias });
  await deps.litellm.addTeamMember(team.teamId, uid);
  await recordAudit(deps.db, { actorUid: actor.uid, action: "MEMBER_ADDED", targetId: team.teamId, details: { membre: uid } });
  if (salarie.email) await notifyMemberAdded(deps, { email: salarie.email, equipe: team.teamAlias, auteur: actor });
  await notifyTeamChange(deps, { type: "membreAjoute", teamId: team.teamId, equipe: team.teamAlias, membre: uid, auteur: actor });
}

/**
 * F-54 : sortie d'une équipe. Ses clés de l'équipe sont révoquées d'abord (un échec laisse le membre en place), puis
 * ses demandes en cours dans l'équipe annulées, avant son retrait de l'équipe dans LiteLLM ; il en est prévenu.
 */
export async function removeTeamMember(deps: TeamDeps, actor: SessionUser, input: { teamId: string; uid: string }): Promise<void> {
  requireAdmin(actor);
  const team = await existingTeam(deps, input.teamId);
  if (!team.memberUids.includes(input.uid)) throw new PortalError("introuvable", `${input.uid} n'est pas membre de ${team.teamAlias}.`, { objet: "membre" });
  const cles = await revokeMemberKeys(deps, actor, team.teamId, input.uid);
  const demandes = await cancelMemberRequests(deps.db, team.teamId, input.uid);
  await deps.litellm.removeTeamMember(team.teamId, input.uid);
  await recordAudit(deps.db, {
    actorUid: actor.uid,
    action: "MEMBER_REMOVED",
    targetId: team.teamId,
    details: { membre: input.uid, clesRevoquees: cles.length, demandesAnnulees: demandes },
  });
  const email = (await deps.litellm.getUser(input.uid))?.email;
  if (email) await notifyMemberRemoved(deps, { email, equipe: team.teamAlias, auteur: actor, cles, demandes });
  await notifyTeamChange(deps, { type: "membreSorti", teamId: team.teamId, equipe: team.teamAlias, membre: input.uid, auteur: actor });
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
