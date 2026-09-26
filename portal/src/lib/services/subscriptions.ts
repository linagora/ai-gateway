import { z } from "zod";
import type { SessionUser } from "@/lib/auth-user";
import type { Db } from "@/lib/db";
import { DUREES_ABONNEMENT } from "@/lib/durees";
import { PortalError } from "@/lib/errors";
import type { LiteLLMClient } from "@/lib/litellm/client";
import { recordAudit } from "./audit";
import { managerEmails } from "./autorite";
import { JOUR, markExpired, pickupDeadline, readPickupDays } from "./echeances";
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

/** Déclaration d'un abonnement par son titulaire : date de souscription (AAAA-MM-JJ), montant mensuel prélevé, adresse du compte. */
export const declarationInputSchema = z.object({
  subscribedAt: z.iso.date(),
  monthlyAmountEur: z.number().positive(),
  accountEmail: z.email(),
});

export type DeclarationInput = z.infer<typeof declarationInputSchema>;

/** Un compte ouvert chez le fournisseur avec une adresse hors de LINAGORA est signalé (gouvernance des données). */
export const horsLinagora = (adresse: string) => !adresse.trim().toLowerCase().endsWith("@linagora.com");

/** Abonnement approuvé qui attend sa déclaration par son titulaire, avec l'échéance de déclaration et le prix de l'offre. */
export interface SubscriptionToDeclare {
  requestId: string;
  offer: string;
  teamAlias: string;
  approvedDays: number;
  declarationDeadline: Date | null;
  suggestedAmountEur: number;
}

/** Abonnement tel que le voit son titulaire. */
export interface MySubscription {
  id: string;
  offer: string;
  supplier: string;
  teamAlias: string;
  accountEmail: string;
  accountOutsideLinagora: boolean;
  subscribedAt: Date;
  monthlyAmountEur: number;
  expiresAt: Date;
  status: "ACTIF" | "A_RESILIER" | "RESILIE";
}

/** Minuit (UTC) du jour d'un instant : les dates d'un abonnement se comptent en jours. */
const jourUtc = (instant: Date) => new Date(Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate()));

/** « Mes abonnements » : les abonnements approuvés à déclarer, puis les abonnements déclarés, du plus récent au plus ancien. */
export async function listMySubscriptions(deps: SubscriptionDeps, user: SessionUser): Promise<{ aDeclarer: SubscriptionToDeclare[]; abonnements: MySubscription[] }> {
  await markExpired(deps.db, deps.now?.() ?? new Date());
  const [demandes, abonnements, delai] = await Promise.all([
    deps.db.accessRequest.findMany({ where: { requesterUid: user.uid, kind: "ABONNEMENT", status: "APPROUVEE" }, include: { offer: true }, orderBy: { decidedAt: "asc" } }),
    deps.db.subscription.findMany({ where: { holderUid: user.uid }, include: { offer: true }, orderBy: [{ subscribedAt: "desc" }, { id: "desc" }] }),
    readPickupDays(deps.db),
  ]);
  return {
    aDeclarer: demandes.flatMap((d) =>
      d.offer
        ? [
            {
              requestId: d.id,
              offer: libelleOffre(d.offer),
              teamAlias: d.teamAlias,
              approvedDays: d.approvedDays ?? 0,
              declarationDeadline: delai !== null && d.decidedAt ? pickupDeadline(d.decidedAt, delai) : null,
              suggestedAmountEur: d.offer.monthlyPriceEur.toNumber(),
            },
          ]
        : [],
    ),
    abonnements: abonnements.map((a) => ({
      id: a.id,
      offer: libelleOffre(a.offer),
      supplier: a.offer.supplier,
      teamAlias: a.teamAlias,
      accountEmail: a.accountEmail,
      accountOutsideLinagora: horsLinagora(a.accountEmail),
      subscribedAt: a.subscribedAt,
      monthlyAmountEur: a.monthlyAmountEur.toNumber(),
      expiresAt: a.expiresAt,
      status: a.status,
    })),
  };
}

/**
 * Le titulaire déclare l'abonnement approuvé qu'il a souscrit : la demande passe « Déclarée » et l'abonnement naît,
 * actif. Son échéance court sur la durée approuvée à partir de la souscription, ou de l'approbation pour un abonnement
 * souscrit avant elle (régularisation). Une date de souscription future est refusée.
 */
export async function declareSubscription(deps: SubscriptionDeps, user: SessionUser, requestId: string, input: DeclarationInput): Promise<string> {
  const data = declarationInputSchema.parse(input);
  const souscription = new Date(`${data.subscribedAt}T00:00:00Z`);
  if (souscription > jourUtc(deps.now?.() ?? new Date())) {
    throw new PortalError("date_future", "La date de souscription ne peut pas être dans le futur.");
  }
  const request = await deps.db.accessRequest.findUnique({ where: { id: requestId }, include: { offer: true } });
  if (!request || request.requesterUid !== user.uid || request.kind !== "ABONNEMENT" || !request.offer) {
    throw new PortalError("introuvable", "Demande d'abonnement introuvable.", { objet: "demande_abonnement" });
  }
  const { offer } = request;
  if (request.status !== "APPROUVEE" || request.approvedDays === null || !request.decidedAt) {
    throw new PortalError("transition_interdite", "Seule une demande d'abonnement approuvée se déclare.");
  }
  const depart = Math.max(souscription.getTime(), jourUtc(request.decidedAt).getTime());
  const abonnement = await deps.db.$transaction(async (tx) => {
    // Condition sur le statut : une demande ne se déclare qu'une fois, même en cas de double envoi.
    const { count } = await tx.accessRequest.updateMany({ where: { id: request.id, status: "APPROUVEE" }, data: { status: "DECLAREE" } });
    if (count === 0) throw new PortalError("transition_interdite", "Cette demande a déjà été traitée.", { cas: "traitee" });
    return tx.subscription.create({
      data: {
        requestId: request.id,
        offerId: offer.id,
        holderUid: request.requesterUid,
        holderEmail: request.requesterEmail,
        holderName: request.requesterName,
        teamId: request.teamId,
        teamAlias: request.teamAlias,
        accountEmail: data.accountEmail.trim(),
        subscribedAt: souscription,
        monthlyAmountEur: data.monthlyAmountEur,
        expiresAt: new Date(depart + (request.approvedDays ?? 0) * JOUR),
      },
    });
  });
  await recordAudit(deps.db, {
    actorUid: user.uid,
    action: "SUBSCRIPTION_DECLARED",
    targetId: abonnement.id,
    details: { offre: libelleOffre(offer), montant: data.monthlyAmountEur, compteHorsLinagora: horsLinagora(data.accountEmail) },
  });
  return abonnement.id;
}
