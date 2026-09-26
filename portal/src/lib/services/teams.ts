import type { SessionUser } from "@/lib/auth-user";
import type { Db } from "@/lib/db";
import { PERIODE_BUDGET } from "@/lib/durees";
import { PortalError } from "@/lib/errors";
import type { LiteLLMClient, LiteLLMTeam } from "@/lib/litellm/client";
import { requireAdmin } from "@/lib/rbac";
import { recordAudit } from "./audit";
import { managerEmails, requireAutorite, requireGestion } from "./autorite";
import { revokeMemberKeys } from "./keys";
import { type NotificationDeps, notifyManagerDesignated, notifyMemberAdded, notifyMemberRemoved, notifyTeamChange } from "./notifications";
import { cancelMemberRequests } from "./requests";

/** Dépendances du service des équipes (F-53) : LiteLLM, source de vérité des équipes, et la base du portail. */
export interface TeamDeps extends NotificationDeps {
  db: Db;
  litellm: LiteLLMClient;
}

/**
 * Budget d'équipe (F-43), lu dans LiteLLM : plafond (null : sans limite), période au format LiteLLM, dépense de la
 * période en cours et date de sa remise à zéro.
 */
export interface TeamBudget {
  max: number | null;
  period: string | null;
  spend: number;
  resetAt: Date | null;
}

/** Équipe telle que la présente la gestion : ses membres réels, ses clés actives émises par le portail, ses responsables, son budget. */
export interface TeamOverview {
  teamId: string;
  teamAlias: string;
  memberCount: number;
  activeKeyCount: number;
  managerUids: string[];
  budget: TeamBudget;
}

/** Responsable d'une équipe, avec l'adresse à laquelle le portail le prévient. */
export interface TeamManagerInfo {
  uid: string;
  email: string;
}

/** Page d'une équipe : son résumé, ses membres réels et ses responsables, par ordre alphabétique. */
export interface TeamPage extends TeamOverview {
  members: string[];
  managers: TeamManagerInfo[];
}

/** Longueur maximale d'un nom d'équipe. */
const NOM_MAX = 100;

/**
 * F-53 : les équipes (pour un responsable, les siennes), par ordre alphabétique, avec leurs membres réels, leurs clés
 * actives et leurs responsables.
 */
export async function listTeamOverviews(deps: TeamDeps, actor: SessionUser): Promise<TeamOverview[]> {
  const equipes = await requireGestion(deps.db, actor);
  const [teams, cles, responsables] = await Promise.all([deps.litellm.listTeams(), activeKeyCounts(deps.db), approversByTeam(deps.db, null)]);
  return teams
    .filter((t) => equipes === null || equipes.includes(t.teamId))
    .map((t) => overview(t, cles, responsables))
    .sort((a, b) => a.teamAlias.localeCompare(b.teamAlias, "fr"));
}

/** F-53 : une équipe ; introuvable si LiteLLM ne la connaît pas. */
export async function getTeamOverview(deps: TeamDeps, actor: SessionUser, teamId: string): Promise<TeamOverview> {
  await requireAutorite(deps.db, actor, teamId, "equipe");
  const team = await existingTeam(deps, teamId);
  return overview(team, await activeKeyCounts(deps.db), await approversByTeam(deps.db, [team.teamId]));
}

/** F-53 : page d'une équipe ; introuvable si LiteLLM ne la connaît pas. */
export async function getTeamPage(deps: TeamDeps, actor: SessionUser, teamId: string): Promise<TeamPage> {
  await requireAutorite(deps.db, actor, teamId, "equipe");
  const team = await existingTeam(deps, teamId);
  const managers = await deps.db.teamManager.findMany({ where: { teamId: team.teamId }, orderBy: { uid: "asc" } });
  return {
    ...overview(team, await activeKeyCounts(deps.db), new Map([[team.teamId, managers.map((m) => m.uid)]])),
    members: [...team.memberUids].sort((a, b) => a.localeCompare(b, "fr")),
    managers: managers.map(({ uid, email }) => ({ uid, email })),
  };
}

/**
 * Valideurs de chaque équipe (F-22) : ses responsables, par ordre alphabétique ; une liste vide veut dire que les admins
 * valident. `teamIds` null : toutes les équipes qui ont des responsables.
 */
export async function approversByTeam(db: Db, teamIds: string[] | null): Promise<Map<string, string[]>> {
  const rows = await db.teamManager.findMany({ where: teamIds ? { teamId: { in: teamIds } } : {}, orderBy: { uid: "asc" } });
  const valideurs = new Map((teamIds ?? []).map((id) => [id, [] as string[]]));
  for (const { teamId, uid } of rows) valideurs.set(teamId, [...(valideurs.get(teamId) ?? []), uid]);
  return valideurs;
}

/**
 * F-54 : désignation d'un responsable d'équipe par un admin. Le salarié doit s'être connecté au portail ; il devient
 * membre de l'équipe s'il ne l'était pas, et il est prévenu de sa désignation.
 */
export async function designateManager(deps: TeamDeps, actor: SessionUser, input: { teamId: string; uid: string }): Promise<void> {
  requireAdmin(actor);
  const team = await existingTeam(deps, input.teamId);
  const uid = input.uid.trim();
  const salarie = uid ? await deps.litellm.getUser(uid) : null;
  if (!salarie) throw new PortalError("salarie_inconnu", `Salarié inconnu de la passerelle : ${uid}.`, { uid });
  if (await deps.db.teamManager.findUnique({ where: { teamId_uid: { teamId: team.teamId, uid } } })) {
    throw new PortalError("responsable_existant", `${uid} est déjà responsable de ${team.teamAlias}.`, { uid, equipe: team.teamAlias });
  }
  if (!team.memberUids.includes(uid)) {
    await deps.litellm.addTeamMember(team.teamId, uid);
    await recordAudit(deps.db, { actorUid: actor.uid, action: "MEMBER_ADDED", targetId: team.teamId, details: { membre: uid } });
  }
  await deps.db.teamManager.create({ data: { teamId: team.teamId, uid, email: salarie.email ?? "", designatedBy: actor.uid } });
  await recordAudit(deps.db, { actorUid: actor.uid, action: "MANAGER_DESIGNATED", targetId: team.teamId, details: { responsable: uid } });
  if (salarie.email) await notifyManagerDesignated(deps, { email: salarie.email, equipe: team.teamAlias, auteur: actor });
  await notifyTeamChange(deps, { type: "responsableDesigne", teamId: team.teamId, equipe: team.teamAlias, responsable: uid, auteur: actor }, await managerEmails(deps.db, team.teamId, [actor.uid, uid]));
}

/** F-54 : retrait du rôle de responsable par un admin ; le salarié reste membre de l'équipe, et il en est prévenu. */
export async function removeManager(deps: TeamDeps, actor: SessionUser, input: { teamId: string; uid: string }): Promise<void> {
  requireAdmin(actor);
  const team = await existingTeam(deps, input.teamId);
  const destinataires = await managerEmails(deps.db, team.teamId, [actor.uid]);
  const { count } = await deps.db.teamManager.deleteMany({ where: { teamId: team.teamId, uid: input.uid } });
  if (count === 0) throw new PortalError("introuvable", `${input.uid} n'est pas responsable de ${team.teamAlias}.`, { objet: "responsable" });
  await recordAudit(deps.db, { actorUid: actor.uid, action: "MANAGER_REMOVED", targetId: team.teamId, details: { responsable: input.uid } });
  await notifyTeamChange(deps, { type: "responsableRetire", teamId: team.teamId, equipe: team.teamAlias, responsable: input.uid, auteur: actor }, destinataires);
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
  await notifyTeamChange(deps, { type: "membreAjoute", teamId: team.teamId, equipe: team.teamAlias, membre: uid, auteur: actor }, await managerEmails(deps.db, team.teamId, [actor.uid]));
}

/**
 * F-54 : sortie d'une équipe, décidée par un admin ou un responsable de l'équipe. Ses clés de l'équipe sont révoquées d'abord (un échec laisse le membre en place), puis
 * ses demandes en cours dans l'équipe annulées, avant son retrait de l'équipe dans LiteLLM ; il en est prévenu.
 */
export async function removeTeamMember(deps: TeamDeps, actor: SessionUser, input: { teamId: string; uid: string }): Promise<void> {
  await requireAutorite(deps.db, actor, input.teamId, "equipe");
  const team = await existingTeam(deps, input.teamId);
  if (!team.memberUids.includes(input.uid)) throw new PortalError("introuvable", `${input.uid} n'est pas membre de ${team.teamAlias}.`, { objet: "membre" });
  const cles = await revokeMemberKeys(deps, actor, team.teamId, input.uid);
  const demandes = await cancelMemberRequests(deps.db, team.teamId, input.uid);
  await deps.litellm.removeTeamMember(team.teamId, input.uid);
  // Sortir de l'équipe, c'est aussi perdre son rôle de responsable.
  const { count: role } = await deps.db.teamManager.deleteMany({ where: { teamId: team.teamId, uid: input.uid } });
  if (role > 0) await recordAudit(deps.db, { actorUid: actor.uid, action: "MANAGER_REMOVED", targetId: team.teamId, details: { responsable: input.uid, motif: "sortie_equipe" } });
  await recordAudit(deps.db, {
    actorUid: actor.uid,
    action: "MEMBER_REMOVED",
    targetId: team.teamId,
    details: { membre: input.uid, clesRevoquees: cles.length, demandesAnnulees: demandes },
  });
  const email = (await deps.litellm.getUser(input.uid))?.email;
  if (email) await notifyMemberRemoved(deps, { email, equipe: team.teamAlias, auteur: actor, cles, demandes });
  await notifyTeamChange(deps, { type: "membreSorti", teamId: team.teamId, equipe: team.teamAlias, membre: input.uid, auteur: actor }, await managerEmails(deps.db, team.teamId, [actor.uid]));
}

/**
 * F-53 : supprime une équipe. LiteLLM supprimant aussi ses clés, la suppression est refusée tant que l'équipe a des clés
 * actives ou des demandes en cours (soumises, à compléter, approuvées sans clé retirée) ; l'historique des demandes reste.
 */
export async function deleteTeam(deps: TeamDeps, actor: SessionUser, teamId: string): Promise<void> {
  requireAdmin(actor);
  const team = await existingTeam(deps, teamId);
  const [cles, demandes] = await Promise.all([
    deps.db.accessRequest.count({ where: { teamId: team.teamId, kind: "CLE", status: "CLE_EMISE" } }),
    deps.db.accessRequest.count({ where: { teamId: team.teamId, status: { in: ["SOUMISE", "A_COMPLETER", "APPROUVEE"] } } }),
  ]);
  if (cles + demandes > 0) {
    throw new PortalError("equipe_non_vide", `L'équipe ${team.teamAlias} a encore des clés ou des demandes en cours.`, { cles: String(cles), demandes: String(demandes) });
  }
  const destinataires = await managerEmails(deps.db, team.teamId, [actor.uid]);
  await deps.litellm.deleteTeam(team.teamId);
  await deps.db.teamManager.deleteMany({ where: { teamId: team.teamId } });
  await deps.db.teamBudgetAlert.deleteMany({ where: { teamId: team.teamId } });
  await recordAudit(deps.db, { actorUid: actor.uid, action: "TEAM_DELETED", targetId: team.teamId, details: { equipe: team.teamAlias } });
  await notifyTeamChange(deps, { type: "supprimee", teamId: team.teamId, equipe: team.teamAlias, auteur: actor }, destinataires);
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

/**
 * F-43 : budget d'équipe fixé par un admin, avec sa période au format d'une clé (30d…) ; 0 retire le plafond. LiteLLM
 * plafonne alors la dépense de toutes les clés de l'équipe, qu'il refuse une fois le budget atteint jusqu'à la période
 * suivante.
 */
export async function setTeamBudget(deps: TeamDeps, actor: SessionUser, input: { teamId: string; budget: number | null; period: string }): Promise<void> {
  requireAdmin(actor);
  const { budget } = input;
  const periode = input.period.trim();
  if (budget === null || !Number.isFinite(budget) || budget < 0 || (budget > 0 && !PERIODE_BUDGET.test(periode))) {
    throw new PortalError("budget_equipe_invalide", "Budget d'équipe négatif, ou positif sans période valide (30d, 12h…).");
  }
  const team = await existingTeam(deps, input.teamId);
  // 0 : sans limite, transmis à LiteLLM comme l'absence de plafond et de période.
  const plafond = budget > 0 ? { montant: budget, periode } : null;
  await deps.litellm.updateTeam(team.teamId, { maxBudget: plafond?.montant ?? null, budgetDuration: plafond?.periode ?? null });
  await recordAudit(deps.db, { actorUid: actor.uid, action: "TEAM_BUDGET_SET", targetId: team.teamId, details: { budget, periode: plafond?.periode ?? null } });
  await notifyTeamChange(deps, { type: "budget", teamId: team.teamId, equipe: team.teamAlias, plafond, auteur: actor }, await managerEmails(deps.db, team.teamId, [actor.uid]));
}

/** F-53 : renomme une équipe ; les clés gardent leur alias et l'historique des demandes l'ancien nom. */
export async function renameTeam(deps: TeamDeps, actor: SessionUser, input: { teamId: string; name: string }): Promise<void> {
  requireAdmin(actor);
  const team = await existingTeam(deps, input.teamId);
  const nom = await nomLibre(deps, input.name, team.teamId);
  if (nom === team.teamAlias) return;
  await deps.litellm.updateTeam(team.teamId, { alias: nom });
  await recordAudit(deps.db, { actorUid: actor.uid, action: "TEAM_RENAMED", targetId: team.teamId, details: { ancienNom: team.teamAlias, nouveauNom: nom } });
  await notifyTeamChange(deps, { type: "renommee", teamId: team.teamId, equipe: nom, ancienNom: team.teamAlias, auteur: actor }, await managerEmails(deps.db, team.teamId, [actor.uid]));
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

function overview(team: LiteLLMTeam, cles: Map<string, number>, responsables: Map<string, string[]>): TeamOverview {
  return {
    teamId: team.teamId,
    teamAlias: team.teamAlias,
    memberCount: team.memberUids.length,
    activeKeyCount: cles.get(team.teamId) ?? 0,
    managerUids: responsables.get(team.teamId) ?? [],
    budget: { max: team.maxBudget, period: team.budgetDuration, spend: team.spend, resetAt: team.budgetResetAt },
  };
}
