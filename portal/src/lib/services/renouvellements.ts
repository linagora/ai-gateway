import { z } from "zod";
import type { Subscription, SubscriptionOffer } from "@/generated/prisma/client";
import type { SessionUser } from "@/lib/auth-user";
import type { Db } from "@/lib/db";
import { DUREES_ABONNEMENT } from "@/lib/durees";
import { PortalError } from "@/lib/errors";
import type { Langue } from "@/lib/langue";
import type { LiteLLMClient } from "@/lib/litellm/client";
import { recordAudit } from "./audit";
import { managerEmails } from "./autorite";
import { JOUR } from "./delais";
import { type NotificationDeps, notifyNewRequest } from "./notifications";
import { type CatalogOffer, libelleOffre, vueCatalogue } from "./offers";
import { SANS_DEMANDE_DE_RESILIATION } from "./resiliations";

/** Dépendances des renouvellements et des changements d'offre : comme une demande d'abonnement. */
export interface RenewalDeps extends NotificationDeps {
  db: Db;
  litellm: LiteLLMClient;
  now?: () => Date;
}

/** Le renouvellement d'un abonnement se demande au plus tôt un mois (30 jours) avant son échéance. */
export const RENOUVELLEMENT_POSSIBLE_AVANT = 30;

/** Renouvellement d'un abonnement : motif, projet éventuel, durée souhaitée et engagement, l'offre et l'équipe restant celles de l'abonnement. */
export const renewalInputSchema = z.object({
  justification: z.string().trim().min(1),
  project: z.string().trim().nullable(),
  requestedDays: z.number().refine((jours) => (DUREES_ABONNEMENT as readonly number[]).includes(jours)),
  commitment: z.boolean(),
});

export type RenewalInput = z.infer<typeof renewalInputSchema>;

/** Changement d'offre : la nouvelle offre, du même fournisseur, en plus des champs d'un renouvellement. */
export const offerChangeInputSchema = renewalInputSchema.extend({ offerId: z.string().min(1) });

export type OfferChangeInput = z.infer<typeof offerChangeInputSchema>;

/** Demande portant sur un abonnement (renouvellement ou changement d'offre) encore en cours : ni décidée, ni déclarée. */
export const DEMANDE_SUR_ABONNEMENT_EN_COURS = { status: { in: ["SOUMISE" as const, "A_COMPLETER" as const, "APPROUVEE" as const] } };

/** Le renouvellement est-il possible à cette date : à partir d'un mois avant l'échéance ? */
export const renouvelableLe = (abonnement: Pick<Subscription, "expiresAt">, maintenant: Date) =>
  maintenant.getTime() >= abonnement.expiresAt.getTime() - RENOUVELLEMENT_POSSIBLE_AVANT * JOUR;

/** Abonnement non résilié de son titulaire, avec son offre ; « introuvable » pour un autre salarié. */
async function abonnementDuTitulaire(db: Db, user: SessionUser, subscriptionId: string): Promise<Subscription & { offer: SubscriptionOffer }> {
  const abonnement = await db.subscription.findUnique({ where: { id: subscriptionId }, include: { offer: true } });
  if (!abonnement || abonnement.holderUid !== user.uid || abonnement.status === "RESILIE") {
    throw new PortalError("introuvable", "Abonnement introuvable.", { objet: "abonnement" });
  }
  return abonnement;
}

/**
 * Contrôles communs : engagement pris, pas d'autre demande en cours sur l'abonnement, titulaire toujours membre de
 * l'équipe de l'abonnement, à laquelle la demande est rattachée.
 */
async function controler(deps: RenewalDeps, user: SessionUser, abonnement: Subscription, commitment: boolean): Promise<void> {
  if (!commitment) {
    throw new PortalError("engagement_requis", "Engagez-vous à ne pas soumettre de données d'un niveau supérieur au niveau maximal de l'offre.");
  }
  const enCours = await deps.db.accessRequest.count({
    where: { OR: [{ renewsSubscriptionId: abonnement.id }, { replacesSubscriptionId: abonnement.id }], ...DEMANDE_SUR_ABONNEMENT_EN_COURS },
  });
  if (enCours > 0) throw new PortalError("demande_en_cours", "Une demande est déjà en cours pour cet abonnement.", { cas: "abonnement" });
  const team = await deps.litellm.getTeam(abonnement.teamId);
  if (!team?.memberUids.includes(user.uid)) {
    throw new PortalError("non_membre", `${user.uid} n'est pas membre de ${abonnement.teamAlias}.`, { equipe: abonnement.teamAlias });
  }
}

/** Crée la demande d'abonnement (renouvellement ou changement d'offre) et l'annonce aux responsables de l'équipe et aux admins. */
async function deposer(
  deps: RenewalDeps,
  user: SessionUser,
  abonnement: Subscription,
  offre: SubscriptionOffer,
  data: RenewalInput,
  lien: { renewsSubscriptionId: string } | { replacesSubscriptionId: string },
) {
  const created = await deps.db.accessRequest.create({
    data: {
      kind: "ABONNEMENT",
      requesterUid: user.uid,
      requesterEmail: user.email,
      requesterName: user.name,
      teamId: abonnement.teamId,
      teamAlias: abonnement.teamAlias,
      offerId: offre.id,
      dataLevel: offre.dataLevel,
      models: [],
      justification: data.justification,
      project: data.project,
      requestedDays: data.requestedDays,
      ...lien,
    },
  });
  await notifyNewRequest(deps, { ...created, offer: offre }, await managerEmails(deps.db, created.teamId, [created.requesterUid]));
  return created;
}

/**
 * Ticket #59 : dès un mois avant l'échéance, le titulaire demande le renouvellement de son abonnement, par une demande
 * préremplie validée comme les autres. Rend l'identifiant de la demande.
 */
export async function requestRenewal(deps: RenewalDeps, user: SessionUser, subscriptionId: string, input: RenewalInput): Promise<{ id: string }> {
  const data = renewalInputSchema.parse(input);
  const abonnement = await abonnementDuTitulaire(deps.db, user, subscriptionId);
  if (!renouvelableLe(abonnement, deps.now?.() ?? new Date())) {
    throw new PortalError("renouvellement_trop_tot", "Le renouvellement se demande au plus tôt un mois avant l'échéance de l'abonnement.");
  }
  await controler(deps, user, abonnement, data.commitment);
  const created = await deposer(deps, user, abonnement, abonnement.offer, data, { renewsSubscriptionId: abonnement.id });
  await recordAudit(deps.db, {
    actorUid: user.uid,
    action: "RENEWAL_REQUESTED",
    targetId: created.id,
    details: { kind: "ABONNEMENT", teamAlias: created.teamAlias, offre: libelleOffre(abonnement.offer), abonnement: abonnement.id },
  });
  return { id: created.id };
}

/**
 * Ticket #59 : à partir d'un abonnement précis, le titulaire demande à passer à une autre offre, visible, du même
 * fournisseur. À la déclaration de la nouvelle offre, cet abonnement-là est résilié. Rend l'identifiant de la demande.
 */
export async function requestOfferChange(deps: RenewalDeps, user: SessionUser, subscriptionId: string, input: OfferChangeInput): Promise<{ id: string }> {
  const data = offerChangeInputSchema.parse(input);
  const abonnement = await abonnementDuTitulaire(deps.db, user, subscriptionId);
  const offre = await deps.db.subscriptionOffer.findUnique({ where: { id: data.offerId } });
  if (!offre?.visible || offre.supplier !== abonnement.offer.supplier || offre.id === abonnement.offerId) {
    throw new PortalError("introuvable", "Offre d'abonnement introuvable.", { objet: "offre" });
  }
  await controler(deps, user, abonnement, data.commitment);
  const created = await deposer(deps, user, abonnement, offre, data, { replacesSubscriptionId: abonnement.id });
  await recordAudit(deps.db, {
    actorUid: user.uid,
    action: "REQUEST_CREATED",
    targetId: created.id,
    details: { kind: "ABONNEMENT", teamAlias: created.teamAlias, offre: libelleOffre(offre), remplace: libelleOffre(abonnement.offer) },
  });
  return { id: created.id };
}

/** Formulaire de renouvellement : l'abonnement (offre, équipe, échéance) et les champs de sa demande d'origine, pour préremplir. */
export interface RenewalDraft {
  subscriptionId: string;
  offer: CatalogOffer;
  teamAlias: string;
  expiresAt: Date;
  justification: string;
  project: string | null;
  requestedDays: number;
}

/** Brouillon du renouvellement d'un abonnement de son titulaire, s'il est possible (échéance proche, aucune demande en cours) ; null sinon. */
export async function renewalDraft(deps: RenewalDeps, user: SessionUser, subscriptionId: string, language: Langue): Promise<RenewalDraft | null> {
  const abonnement = await abonnementDuTitulaire(deps.db, user, subscriptionId).catch(() => null);
  if (!abonnement || !renouvelableLe(abonnement, deps.now?.() ?? new Date())) return null;
  const origine = await deps.db.accessRequest.findUnique({ where: { id: abonnement.requestId } });
  return {
    subscriptionId: abonnement.id,
    offer: vueCatalogue(abonnement.offer, language),
    teamAlias: abonnement.teamAlias,
    expiresAt: abonnement.expiresAt,
    justification: origine?.justification ?? "",
    project: origine?.project ?? null,
    requestedDays: origine?.approvedDays && (DUREES_ABONNEMENT as readonly number[]).includes(origine.approvedDays) ? origine.approvedDays : 90,
  };
}

/** Formulaire de changement d'offre : l'abonnement d'origine et les autres offres visibles de son fournisseur. */
export interface OfferChangeDraft {
  subscriptionId: string;
  currentOffer: string;
  teamAlias: string;
  offers: CatalogOffer[];
}

/** Brouillon du changement d'offre d'un abonnement de son titulaire ; null si l'abonnement n'est pas le sien ou est résilié. */
export async function offerChangeDraft(deps: RenewalDeps, user: SessionUser, subscriptionId: string, language: Langue): Promise<OfferChangeDraft | null> {
  const abonnement = await abonnementDuTitulaire(deps.db, user, subscriptionId).catch(() => null);
  if (!abonnement) return null;
  const offres = await deps.db.subscriptionOffer.findMany({
    where: { visible: true, supplier: abonnement.offer.supplier, id: { not: abonnement.offerId } },
    orderBy: [{ monthlyPriceEur: "asc" }, { name: "asc" }],
  });
  return {
    subscriptionId: abonnement.id,
    currentOffer: libelleOffre(abonnement.offer),
    teamAlias: abonnement.teamAlias,
    offers: offres.map((o) => vueCatalogue(o, language)),
  };
}

/**
 * Renouvellement approuvé : l'échéance de l'abonnement est reportée de la durée approuvée, à partir de l'échéance en
 * cours ; une demande de résiliation née de l'échéance est levée, et les rappels d'échéance repartent. Rend la nouvelle
 * échéance.
 */
export async function reporterEcheance(db: Db, abonnement: Subscription, jours: number): Promise<Date> {
  const echeance = new Date(abonnement.expiresAt.getTime() + jours * JOUR);
  const levee = abonnement.status === "A_RESILIER" && abonnement.terminationOrigin === "ECHEANCE";
  await db.subscription.update({
    where: { id: abonnement.id },
    data: { expiresAt: echeance, expiryReminderLead: null, expiryReminderSentAt: null, ...(levee ? SANS_DEMANDE_DE_RESILIATION : {}) },
  });
  return echeance;
}
