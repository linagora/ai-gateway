import { z } from "zod";
import type { SessionUser } from "@/lib/auth-user";
import type { Db } from "@/lib/db";
import { DUREES_ABONNEMENT } from "@/lib/durees";
import { PortalError } from "@/lib/errors";
import type { LiteLLMClient } from "@/lib/litellm/client";
import { recordAudit } from "./audit";
import { managerEmails } from "./autorite";
import { type NotificationDeps, notifyNewRequest } from "./notifications";
import { libelleOffre } from "./offers";
import { transitionRequest } from "./requests";

/** Dépendances du service des abonnements (spécification #51). */
export interface SubscriptionDeps extends NotificationDeps {
  db: Db;
  litellm: LiteLLMClient;
  /** Date du jour, injectée par les tests ; l'heure réelle sinon. */
  now?: () => Date;
}

/**
 * Demande d'abonnement d'un membre d'une équipe : l'offre, l'équipe, le motif, le projet éventuel, la durée souhaitée,
 * et l'engagement à ne pas confier de données d'un niveau supérieur au niveau maximal de l'offre.
 */
export const subscriptionRequestInputSchema = z.object({
  offerId: z.string().min(1),
  teamId: z.string().min(1),
  justification: z.string().trim().min(1),
  project: z.string().trim().nullable(),
  requestedDays: z.number().refine((jours) => (DUREES_ABONNEMENT as readonly number[]).includes(jours)),
  commitment: z.boolean(),
});

export type SubscriptionRequestInput = z.infer<typeof subscriptionRequestInputSchema>;

/** Enregistre une demande d'abonnement au statut SOUMISE, l'inscrit au journal et l'annonce aux responsables et aux admins. */
export async function createSubscriptionRequest(deps: SubscriptionDeps, user: SessionUser, input: SubscriptionRequestInput): Promise<{ id: string }> {
  const { champs, offre } = await validateSubscriptionRequest(deps, user, input);
  const created = await deps.db.accessRequest.create({
    data: { kind: "ABONNEMENT", requesterUid: user.uid, requesterEmail: user.email, requesterName: user.name, ...champs },
  });
  await recordAudit(deps.db, {
    actorUid: user.uid,
    action: "REQUEST_CREATED",
    targetId: created.id,
    details: { kind: "ABONNEMENT", teamAlias: created.teamAlias, offre: libelleOffre(offre) },
  });
  await notifyNewRequest(deps, { ...created, offer: offre }, await managerEmails(deps.db, created.teamId, [created.requesterUid]));
  return { id: created.id };
}

/** Brouillon d'une demande d'abonnement renvoyée pour complément, pour préremplir le formulaire de son demandeur. */
export async function subscriptionRequestDraft(deps: { db: Db }, user: SessionUser, id: string): Promise<Omit<SubscriptionRequestInput, "commitment"> | null> {
  const r = await deps.db.accessRequest.findUnique({ where: { id } });
  if (!r || r.requesterUid !== user.uid || r.kind !== "ABONNEMENT" || r.status !== "A_COMPLETER" || !r.offerId || r.requestedDays === null) return null;
  return { offerId: r.offerId, teamId: r.teamId, justification: r.justification, project: r.project, requestedDays: r.requestedDays };
}

/** Le demandeur complète sa demande d'abonnement renvoyée pour complément ; elle repasse en SOUMISE. */
export async function completeSubscriptionRequest(deps: SubscriptionDeps, user: SessionUser, id: string, input: SubscriptionRequestInput): Promise<void> {
  const request = await deps.db.accessRequest.findUnique({ where: { id } });
  if (!request || request.requesterUid !== user.uid || request.kind !== "ABONNEMENT") {
    throw new PortalError("introuvable", "Demande d'abonnement introuvable.", { objet: "demande_abonnement" });
  }
  const { champs } = await validateSubscriptionRequest(deps, user, input);
  await transitionRequest(deps.db, request, "SOUMISE", { data: champs });
}

/** Saisie validée, engagement pris, offre proposée au catalogue, équipe existante dont le demandeur est membre. */
async function validateSubscriptionRequest(deps: SubscriptionDeps, user: SessionUser, input: SubscriptionRequestInput) {
  const data = subscriptionRequestInputSchema.parse(input);
  if (!data.commitment) {
    throw new PortalError("engagement_requis", "Engagez-vous à ne pas soumettre de données d'un niveau supérieur au niveau maximal de l'offre.");
  }
  const offre = await deps.db.subscriptionOffer.findUnique({ where: { id: data.offerId } });
  if (!offre?.visible) throw new PortalError("introuvable", "Offre d'abonnement introuvable.", { objet: "offre" });
  const team = await deps.litellm.getTeam(data.teamId);
  if (!team) throw new PortalError("introuvable", "Équipe introuvable.", { objet: "equipe" });
  if (!team.memberUids.includes(user.uid)) throw new PortalError("non_membre", `${user.uid} n'est pas membre de ${team.teamAlias}.`, { equipe: team.teamAlias });
  return {
    offre,
    champs: {
      teamId: team.teamId,
      teamAlias: team.teamAlias,
      offerId: offre.id,
      dataLevel: offre.dataLevel,
      models: [],
      justification: data.justification,
      project: data.project,
      requestedDays: data.requestedDays,
    },
  };
}
