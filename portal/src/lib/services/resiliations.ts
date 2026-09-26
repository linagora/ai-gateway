import { z } from "zod";
import type { Subscription, SubscriptionOffer, TerminationOrigin } from "@/generated/prisma/client";
import type { SessionUser } from "@/lib/auth-user";
import type { Db } from "@/lib/db";
import { PortalError } from "@/lib/errors";
import type { LiteLLMClient } from "@/lib/litellm/client";
import { recordAudit } from "./audit";
import { managerEmails, requireAutorite } from "./autorite";
import { pickupDeadline, readPickupDays, SYSTEME } from "./delais";
import { type NotificationDeps, notifyTeamChange, notifyTerminationDeclaredByAdmin, notifyTerminationRequested } from "./notifications";
import { libelleOffre } from "./offers";
import { enregistrerPrelevements, jourUtc } from "./prelevements";

/** Dépendances des résiliations : la base, LiteLLM (équipes et salariés), l'expéditeur, et la date du jour injectée. */
export interface TerminationDeps extends NotificationDeps {
  db: Db;
  litellm: LiteLLMClient;
  now?: () => Date;
}

/** Déclaration d'une résiliation : sa date (AAAA-MM-JJ). */
export const terminationInputSchema = z.object({ terminatedOn: z.iso.date() });

export type TerminationInput = z.infer<typeof terminationInputSchema>;

const introuvable = () => new PortalError("introuvable", "Abonnement introuvable.", { objet: "abonnement" });

/** Demande de résiliation posée sur un abonnement actif : il passe « à résilier », avec l'origine, l'auteur, la date et le motif. */
const demandeDeResiliation = (origine: TerminationOrigin, auteur: string, maintenant: Date, motif: string | null) => ({
  status: "A_RESILIER" as const,
  terminationOrigin: origine,
  terminationRequestedBy: auteur,
  terminationRequestedAt: maintenant,
  terminationReason: motif,
  terminationAlertSentAt: null,
});

/** Abonnement de nouveau actif : sans demande de résiliation (levée par un rattachement ou un renouvellement). */
export const SANS_DEMANDE_DE_RESILIATION = {
  status: "ACTIF" as const,
  terminationOrigin: null,
  terminationRequestedBy: null,
  terminationRequestedAt: null,
  terminationReason: null,
  terminationAlertSentAt: null,
};

/**
 * Pose une demande de résiliation sur un abonnement actif, l'inscrit au journal et en prévient le titulaire, avec
 * l'échéance de la déclaration. Rend faux si l'abonnement n'était plus actif (rien n'est alors fait).
 */
async function poserDemande(
  deps: TerminationDeps,
  abonnement: Subscription & { offer: SubscriptionOffer },
  demande: { origine: TerminationOrigin; auteur: string; maintenant: Date; motif: string | null; echeance: Date | null },
): Promise<boolean> {
  const champs = demandeDeResiliation(demande.origine, demande.auteur, demande.maintenant, demande.motif);
  const { count } = await deps.db.subscription.updateMany({ where: { id: abonnement.id, status: "ACTIF" }, data: champs });
  if (count === 0) return false;
  await recordAudit(deps.db, {
    actorUid: demande.auteur,
    action: "SUBSCRIPTION_TERMINATION_REQUESTED",
    targetId: abonnement.id,
    details: { origine: demande.origine, offre: libelleOffre(abonnement.offer), equipe: abonnement.teamAlias, motif: demande.motif },
  });
  await notifyTerminationRequested(deps, { ...abonnement, ...champs }, abonnement.offer, demande.echeance);
  return true;
}

/**
 * Résiliation d'un abonnement à la date donnée : il passe « résilié » ; les prélèvements comptés à partir de cette date
 * sont retirés, et ceux échus avant elle, que la tâche quotidienne n'aurait pas encore comptés, sont ajoutés.
 */
export async function enregistrerResiliation(db: Db, abonnement: Subscription, date: Date, maintenant: Date): Promise<void> {
  await db.$transaction(async (tx) => {
    // Condition sur le statut : une résiliation ne s'enregistre qu'une fois, même en cas de double envoi.
    const { count } = await tx.subscription.updateMany({ where: { id: abonnement.id, status: { not: "RESILIE" } }, data: { status: "RESILIE", terminatedOn: date } });
    if (count === 0) throw new PortalError("transition_interdite", "Cet abonnement est déjà résilié.", { cas: "abonnement" });
    await tx.subscriptionCharge.deleteMany({ where: { subscriptionId: abonnement.id, chargedOn: { gte: date } } });
  });
  await enregistrerPrelevements(db, { ...abonnement, terminatedOn: date }, maintenant);
}

/** Échéance de la déclaration d'une résiliation demandée : la date de la demande plus le délai de retrait, s'il est fixé. */
async function echeanceDeDeclaration(db: Db, demandeeLe: Date): Promise<Date | null> {
  const delai = await readPickupDays(db);
  return delai !== null ? pickupDeadline(demandeeLe, delai) : null;
}

/**
 * Spécification #51, ticket #58 : le titulaire déclare la résiliation de son abonnement, avec sa date ; un admin peut la
 * déclarer à sa place, et le titulaire, s'il est toujours connu de la passerelle, en est prévenu. La date n'est ni
 * future ni antérieure à la souscription. Aucun prélèvement ne compte à partir de cette date : ceux déjà comptés à tort
 * sont retirés. L'abonnement résilié passe dans l'archive.
 */
export async function declareTermination(deps: TerminationDeps, actor: SessionUser, subscriptionId: string, input: TerminationInput): Promise<void> {
  const { terminatedOn: saisie } = terminationInputSchema.parse(input);
  const date = new Date(`${saisie}T00:00:00Z`);
  const maintenant = deps.now?.() ?? new Date();
  const abonnement = await deps.db.subscription.findUnique({ where: { id: subscriptionId }, include: { offer: true } });
  if (!abonnement || (abonnement.holderUid !== actor.uid && !actor.isAdmin)) throw introuvable();
  if (abonnement.status === "RESILIE") throw new PortalError("transition_interdite", "Cet abonnement est déjà résilié.", { cas: "abonnement" });
  if (date > jourUtc(maintenant)) throw new PortalError("date_future", "La date de résiliation ne peut pas être dans le futur.", { objet: "resiliation" });
  if (date < abonnement.subscribedAt) throw new PortalError("date_avant_souscription", "La date de résiliation ne peut pas précéder la souscription.");
  // Déclarée par un admin, la résiliation est annoncée au titulaire s'il est toujours là (connu de la passerelle).
  const titulaire = abonnement.holderUid !== actor.uid ? await deps.litellm.getUser(abonnement.holderUid) : null;
  await enregistrerResiliation(deps.db, abonnement, date, maintenant);
  await recordAudit(deps.db, {
    actorUid: actor.uid,
    action: "SUBSCRIPTION_TERMINATED",
    targetId: abonnement.id,
    details: { offre: libelleOffre(abonnement.offer), equipe: abonnement.teamAlias, date: saisie },
  });
  if (titulaire) await notifyTerminationDeclaredByAdmin(deps, abonnement, abonnement.offer, date, titulaire.email || abonnement.holderEmail);
}

/**
 * Un responsable de l'équipe de l'abonnement, ou un admin, en demande la résiliation, avec un motif : l'abonnement passe
 * « à résilier ». Le titulaire en est prévenu, et la demande est annoncée comme un changement dans l'équipe.
 */
export async function requestTermination(deps: TerminationDeps, actor: SessionUser, subscriptionId: string, input: { reason: string }): Promise<void> {
  const abonnement = await deps.db.subscription.findUnique({ where: { id: subscriptionId }, include: { offer: true } });
  if (!abonnement) throw introuvable();
  await requireAutorite(deps.db, actor, abonnement.teamId, "abonnement");
  const motif = input.reason.trim();
  if (!motif) throw new PortalError("motif_obligatoire", "Le motif de la demande de résiliation est obligatoire.");
  const maintenant = deps.now?.() ?? new Date();
  const origine: TerminationOrigin = actor.isAdmin ? "ADMIN" : "RESPONSABLE";
  const echeance = await echeanceDeDeclaration(deps.db, maintenant);
  if (!(await poserDemande(deps, abonnement, { origine, auteur: actor.uid, maintenant, motif, echeance }))) {
    throw new PortalError("transition_interdite", "Cet abonnement n'est plus actif.", { cas: "abonnement" });
  }
  await notifyTeamChange(
    deps,
    { type: "resiliationDemandee", teamId: abonnement.teamId, equipe: abonnement.teamAlias, titulaire: abonnement.holderUid, offre: libelleOffre(abonnement.offer), auteur: actor },
    await managerEmails(deps.db, abonnement.teamId, [actor.uid, abonnement.holderUid]),
  );
}

/**
 * Sortie d'une équipe (ticket #58) : chaque abonnement actif du membre rattaché à cette équipe fait l'objet d'une demande
 * de résiliation, dont le titulaire est prévenu. Rend le nombre d'abonnements devenus « à résilier ».
 */
export async function requestTerminationsOnExit(deps: TerminationDeps, actor: SessionUser, teamId: string, uid: string): Promise<number> {
  const maintenant = deps.now?.() ?? new Date();
  const abonnements = await deps.db.subscription.findMany({ where: { holderUid: uid, teamId, status: "ACTIF" }, include: { offer: true } });
  const echeance = abonnements.length > 0 ? await echeanceDeDeclaration(deps.db, maintenant) : null;
  let demandes = 0;
  for (const abonnement of abonnements) {
    if (await poserDemande(deps, abonnement, { origine: "SORTIE", auteur: actor.uid, maintenant, motif: null, echeance })) demandes++;
  }
  return demandes;
}

/**
 * Ticket #59 : le refus du renouvellement d'un abonnement actif en fait une demande de résiliation, par l'auteur du
 * refus et avec son motif ; le titulaire en est prévenu.
 */
export async function requestTerminationAfterRefusedRenewal(deps: TerminationDeps, actor: SessionUser, subscriptionId: string, motif: string): Promise<void> {
  const abonnement = await deps.db.subscription.findUnique({ where: { id: subscriptionId }, include: { offer: true } });
  if (!abonnement) return;
  const maintenant = deps.now?.() ?? new Date();
  const echeance = await echeanceDeDeclaration(deps.db, maintenant);
  await poserDemande(deps, abonnement, { origine: "RENOUVELLEMENT_REFUSE", auteur: actor.uid, maintenant, motif, echeance });
}

/**
 * Ticket #59, tâche quotidienne : à l'échéance d'un abonnement actif non renouvelé, une demande de résiliation part à
 * son titulaire ; un renouvellement en attente de décision la suspend. Rend le nombre de demandes faites.
 */
export async function requestTerminationsAtExpiry(deps: TerminationDeps, maintenant: Date): Promise<number> {
  const echus = await deps.db.subscription.findMany({ where: { status: "ACTIF", expiresAt: { lte: maintenant } }, include: { offer: true } });
  if (echus.length === 0) return 0;
  const renouvellements = await deps.db.accessRequest.findMany({
    where: { renewsSubscriptionId: { in: echus.map((a) => a.id) }, status: { in: ["SOUMISE", "A_COMPLETER"] } },
    select: { renewsSubscriptionId: true },
  });
  const enAttente = new Set(renouvellements.map((r) => r.renewsSubscriptionId));
  const echeance = await echeanceDeDeclaration(deps.db, maintenant);
  let demandes = 0;
  for (const abonnement of echus) {
    if (enAttente.has(abonnement.id)) continue;
    if (await poserDemande(deps, abonnement, { origine: "ECHEANCE", auteur: SYSTEME, maintenant, motif: null, echeance })) demandes++;
  }
  return demandes;
}

/**
 * Un admin, ou un responsable de l'équipe d'arrivée, rattache un abonnement non résilié à une autre équipe dont son
 * titulaire est membre. Les prélèvements échus restent à l'ancienne équipe ; les suivants vont à la nouvelle. Une demande
 * de résiliation née de la sortie de l'ancienne équipe est levée ; les autres demeurent.
 */
export async function reattachSubscription(deps: TerminationDeps, actor: SessionUser, subscriptionId: string, input: { teamId: string }): Promise<void> {
  const abonnement = await deps.db.subscription.findUnique({ where: { id: subscriptionId }, include: { offer: true } });
  if (!abonnement || abonnement.status === "RESILIE") throw introuvable();
  await requireAutorite(deps.db, actor, input.teamId, "equipe");
  const equipe = await deps.litellm.getTeam(input.teamId);
  if (!equipe) throw new PortalError("introuvable", `Équipe introuvable : ${input.teamId}.`, { objet: "equipe" });
  if (!equipe.memberUids.includes(abonnement.holderUid)) {
    throw new PortalError("non_membre", `${abonnement.holderUid} n'est pas membre de ${equipe.teamAlias}.`, { cas: "titulaire", uid: abonnement.holderUid, equipe: equipe.teamAlias });
  }
  await enregistrerPrelevements(deps.db, abonnement, deps.now?.() ?? new Date());
  const levee = abonnement.status === "A_RESILIER" && abonnement.terminationOrigin === "SORTIE";
  await deps.db.subscription.update({ where: { id: abonnement.id }, data: { teamId: equipe.teamId, teamAlias: equipe.teamAlias, ...(levee ? SANS_DEMANDE_DE_RESILIATION : {}) } });
  await recordAudit(deps.db, {
    actorUid: actor.uid,
    action: "SUBSCRIPTION_REATTACHED",
    targetId: abonnement.id,
    details: { offre: libelleOffre(abonnement.offer), de: abonnement.teamAlias, vers: equipe.teamAlias, demandeLevee: levee },
  });
}

/** Abonnement à rattacher : celui d'un membre de l'équipe, à résilier depuis sa sortie d'une autre équipe. */
export interface SubscriptionToReattach {
  id: string;
  holderUid: string;
  offer: string;
  teamAlias: string;
  requestedAt: Date | null;
}

/**
 * Page d'une équipe : les abonnements de ses membres, à résilier depuis leur sortie d'une autre équipe, que la page
 * propose de rattacher à cette équipe, de la plus ancienne demande à la plus récente.
 */
export async function subscriptionsToReattach(db: Db, teamId: string, memberUids: string[]): Promise<SubscriptionToReattach[]> {
  const abonnements = await db.subscription.findMany({
    where: { holderUid: { in: memberUids }, status: "A_RESILIER", terminationOrigin: "SORTIE", teamId: { not: teamId } },
    include: { offer: true },
    orderBy: [{ terminationRequestedAt: "asc" }, { id: "asc" }],
  });
  return abonnements.map((a) => ({ id: a.id, holderUid: a.holderUid, offer: libelleOffre(a.offer), teamAlias: a.teamAlias, requestedAt: a.terminationRequestedAt }));
}
