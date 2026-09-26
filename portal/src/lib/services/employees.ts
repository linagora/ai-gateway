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
