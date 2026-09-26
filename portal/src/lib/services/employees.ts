import type { SessionUser } from "@/lib/auth-user";
import { PortalError } from "@/lib/errors";
import { dansEquipes, requireGestion } from "./autorite";
import { type AdminKey, type AdminKeyToPickUp, type KeyDeps, listActiveKeys, listKeysToPickUp } from "./keys";
import { type AdminSubscription, type AdminSubscriptionToDeclare, listActiveSubscriptions, listSubscriptionsToDeclare, type SubscriptionDeps } from "./subscriptions";

/** Dépendances de la fiche d'un salarié : celles des clés et des abonnements. */
export type EmployeeDeps = KeyDeps & SubscriptionDeps;

/** Équipe d'un salarié, telle que sa fiche la montre : avec son rôle de responsable. */
export interface EmployeeTeam {
  teamId: string;
  teamAlias: string;
  manager: boolean;
}

/**
 * Fiche d'un salarié (retours de l'utilisateur du 2026-09-26) : ce qu'il utilise en ce moment, clés et abonnements,
 * avec ses équipes ; pour un responsable, ce qui relève de ses équipes.
 */
export interface EmployeePage {
  uid: string;
  email: string | null;
  teams: EmployeeTeam[];
  keysToPickUp: AdminKeyToPickUp[];
  activeKeys: AdminKey[];
  subscriptionsToDeclare: AdminSubscriptionToDeclare[];
  activeSubscriptions: AdminSubscription[];
}

/** Salarié tel que l'onglet « Salariés » le présente : ses équipes et ce qu'il utilise, dans le périmètre de l'acteur. */
export interface EmployeeSummary {
  uid: string;
  email: string | null;
  teams: string[];
  activeKeyCount: number;
  activeSubscriptionCount: number;
}

/**
 * Onglet « Salariés » : les salariés connus du portail (membres ou responsables d'une équipe, auteurs d'une demande,
 * titulaires d'un abonnement), par uid, avec leurs équipes, leurs clés actives et leurs abonnements actifs ; pour un
 * responsable, ceux de ses équipes, avec ce qu'ils y utilisent ; avec `equipe`, ceux de cette seule équipe. La recherche
 * retient les salariés dont l'uid ou l'adresse contient le texte, sans tenir compte de la casse. L'adresse vient de leur
 * demande la plus récente, de leur abonnement ou de leur désignation comme responsable : un membre sans rien de tout
 * cela n'en a pas ici.
 */
export async function listEmployees(deps: EmployeeDeps, actor: SessionUser, { recherche = "", equipe }: { recherche?: string; equipe?: string } = {}): Promise<EmployeeSummary[]> {
  const equipes = await requireGestion(deps.db, actor);
  const perimetre = dansEquipes(equipes, equipe);
  const [teams, responsables, demandes, abonnements, cles, actifs] = await Promise.all([
    deps.litellm.listTeams(),
    deps.db.teamManager.findMany({ where: perimetre, select: { uid: true, email: true, teamId: true } }),
    deps.db.accessRequest.findMany({ where: perimetre, distinct: ["requesterUid"], select: { requesterUid: true, requesterEmail: true }, orderBy: { createdAt: "desc" } }),
    deps.db.subscription.findMany({ where: perimetre, distinct: ["holderUid"], select: { holderUid: true, holderEmail: true }, orderBy: { createdAt: "desc" } }),
    deps.db.accessRequest.groupBy({ by: ["requesterUid"], where: { kind: "CLE", status: "CLE_EMISE", keyIssuedAt: { not: null }, ...perimetre }, _count: { _all: true } }),
    deps.db.subscription.groupBy({ by: ["holderUid"], where: { status: { not: "RESILIE" }, ...perimetre }, _count: { _all: true } }),
  ]);
  const visibles = teams.filter((t) => (equipe === undefined || t.teamId === equipe) && (equipes === null || equipes.includes(t.teamId)));
  const alias = new Map(visibles.map((t) => [t.teamId, t.teamAlias]));
  const salaries = new Map<string, { email: string | null; teams: Set<string> }>();
  const salarie = (uid: string) => {
    const existant = salaries.get(uid);
    if (existant) return existant;
    const nouveau = { email: null, teams: new Set<string>() };
    salaries.set(uid, nouveau);
    return nouveau;
  };
  for (const t of visibles) for (const uid of t.memberUids) salarie(uid).teams.add(t.teamAlias);
  for (const d of demandes) salarie(d.requesterUid).email ??= d.requesterEmail;
  for (const a of abonnements) salarie(a.holderUid).email ??= a.holderEmail;
  for (const r of responsables) {
    const s = salarie(r.uid);
    s.email ??= r.email;
    const nom = alias.get(r.teamId);
    if (nom) s.teams.add(nom);
  }
  const nombreDeCles = new Map(cles.map((c) => [c.requesterUid, c._count._all]));
  const nombreDAbonnements = new Map(actifs.map((a) => [a.holderUid, a._count._all]));
  const texte = recherche.trim().toLocaleLowerCase("fr");
  return [...salaries]
    .filter(([uid, s]) => !texte || uid.toLocaleLowerCase("fr").includes(texte) || (s.email?.toLocaleLowerCase("fr").includes(texte) ?? false))
    .sort(([a], [b]) => a.localeCompare(b, "fr"))
    .map(([uid, s]) => ({
      uid,
      email: s.email,
      teams: [...s.teams].sort((a, b) => a.localeCompare(b, "fr")),
      activeKeyCount: nombreDeCles.get(uid) ?? 0,
      activeSubscriptionCount: nombreDAbonnements.get(uid) ?? 0,
    }));
}

/**
 * Fiche d'un salarié, pour un admin ou un responsable d'équipe. Un salarié est connu d'un admin s'il est utilisateur de
 * la passerelle, membre d'une équipe ou auteur d'une demande ; d'un responsable, s'il est membre de l'une de ses équipes
 * ou y a une demande ou un abonnement. Sinon, il est introuvable.
 */
export async function getEmployeePage(deps: EmployeeDeps, actor: SessionUser, uid: string): Promise<EmployeePage> {
  const equipes = await requireGestion(deps.db, actor);
  const [teams, responsabilites, utilisateur, demande, abonnement] = await Promise.all([
    deps.litellm.listTeams(),
    deps.db.teamManager.findMany({ where: { uid }, select: { teamId: true } }),
    deps.litellm.getUser(uid),
    deps.db.accessRequest.findFirst({ where: { requesterUid: uid, ...dansEquipes(equipes) }, select: { requesterEmail: true }, orderBy: { createdAt: "desc" } }),
    deps.db.subscription.findFirst({ where: { holderUid: uid, ...dansEquipes(equipes) }, select: { holderEmail: true }, orderBy: { createdAt: "desc" } }),
  ]);
  const gerees = new Set(responsabilites.map((r) => r.teamId));
  const siennes = teams
    .filter((t) => (t.memberUids.includes(uid) || gerees.has(t.teamId)) && (equipes === null || equipes.includes(t.teamId)))
    .map((t) => ({ teamId: t.teamId, teamAlias: t.teamAlias, manager: gerees.has(t.teamId) }))
    .sort((a, b) => a.teamAlias.localeCompare(b.teamAlias, "fr"));
  const connu = siennes.length > 0 || demande !== null || abonnement !== null || (equipes === null && utilisateur !== null);
  if (!connu) throw new PortalError("introuvable", `Salarié ${uid} introuvable pour ${actor.uid}.`, { objet: "salarie" });

  const filtre = { titulaire: uid };
  const [keysToPickUp, activeKeys, subscriptionsToDeclare, activeSubscriptions] = await Promise.all([
    listKeysToPickUp(deps, actor, filtre),
    listActiveKeys(deps, actor, filtre),
    listSubscriptionsToDeclare(deps, actor, filtre),
    listActiveSubscriptions(deps, actor, filtre),
  ]);
  return {
    uid,
    email: utilisateur?.email ?? demande?.requesterEmail ?? abonnement?.holderEmail ?? null,
    teams: siennes,
    keysToPickUp,
    activeKeys,
    subscriptionsToDeclare,
    activeSubscriptions,
  };
}
