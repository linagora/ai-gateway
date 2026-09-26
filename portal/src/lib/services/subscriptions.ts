import { z } from "zod";
import type { Subscription, SubscriptionCharge, SubscriptionOffer, TerminationOrigin } from "@/generated/prisma/client";
import type { SessionUser } from "@/lib/auth-user";
import type { Db } from "@/lib/db";
import type { Langue } from "@/lib/langue";
import { estDureeAbonnement } from "@/lib/durees";
import { PortalError } from "@/lib/errors";
import type { LiteLLMClient } from "@/lib/litellm/client";
import { type Page, tranche } from "@/lib/pagination";
import { recordAudit } from "./audit";
import { dansEquipes, managerEmails, requireGestion } from "./autorite";
import { JOUR, pickupDeadline, readPickupDays } from "./delais";
import { markExpired } from "./echeances";
import { type NotificationDeps, notifyNewRequest } from "./notifications";
import { type CatalogOffer, libelleOffre, vueCatalogue } from "./offers";
import { enregistrerPrelevements, jourUtc } from "./prelevements";
import { DEMANDE_SUR_ABONNEMENT_EN_COURS, renewalInputSchema, renouvelableLe } from "./renouvellements";
import { transitionRequest } from "./requests";
import { enregistrerResiliation } from "./resiliations";

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
  requestedDays: z.number().refine(estDureeAbonnement),
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

/**
 * Brouillon d'une demande d'abonnement renvoyée pour complément, pour préremplir le formulaire de son demandeur : ses
 * champs, son offre (même masquée depuis) et, pour un renouvellement ou un changement d'offre, ce lien à un abonnement.
 */
export interface SubscriptionRequestDraft extends Omit<SubscriptionRequestInput, "commitment"> {
  offer: CatalogOffer;
  teamAlias: string;
  linked: "RENOUVELLEMENT" | "CHANGEMENT_OFFRE" | null;
}

/** Brouillon de la demande d'abonnement du salarié renvoyée pour complément ; null si elle n'est pas à compléter. */
export async function subscriptionRequestDraft(deps: { db: Db }, user: SessionUser, id: string, language: Langue = "fr"): Promise<SubscriptionRequestDraft | null> {
  const r = await deps.db.accessRequest.findUnique({ where: { id }, include: { offer: true } });
  if (!r || r.requesterUid !== user.uid || r.kind !== "ABONNEMENT" || r.status !== "A_COMPLETER" || !r.offer || r.requestedDays === null) return null;
  return {
    offerId: r.offer.id,
    offer: vueCatalogue(r.offer, language),
    teamId: r.teamId,
    teamAlias: r.teamAlias,
    justification: r.justification,
    project: r.project,
    requestedDays: r.requestedDays,
    linked: r.renewsSubscriptionId ? "RENOUVELLEMENT" : r.replacesSubscriptionId ? "CHANGEMENT_OFFRE" : null,
  };
}

/**
 * Le demandeur complète sa demande d'abonnement renvoyée pour complément ; elle repasse en SOUMISE. Un renouvellement
 * ou un changement d'offre (ticket #59) garde l'offre et l'équipe de sa demande : seuls le motif, le projet et la durée
 * souhaitée changent.
 */
export async function completeSubscriptionRequest(deps: SubscriptionDeps, user: SessionUser, id: string, input: SubscriptionRequestInput): Promise<void> {
  const request = await deps.db.accessRequest.findUnique({ where: { id } });
  if (!request || request.requesterUid !== user.uid || request.kind !== "ABONNEMENT") {
    throw new PortalError("introuvable", "Demande d'abonnement introuvable.", { objet: "demande_abonnement" });
  }
  if (request.renewsSubscriptionId || request.replacesSubscriptionId) {
    const { justification, project, requestedDays, commitment } = renewalInputSchema.parse(input);
    if (!commitment) throw new PortalError("engagement_requis", "Engagez-vous à ne pas soumettre de données d'un niveau supérieur au niveau maximal de l'offre.");
    await transitionRequest(deps.db, request, "SOUMISE", { data: { justification, project, requestedDays } });
    return;
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

/** Demande de résiliation d'un abonnement (ticket #58) : son origine, son auteur, sa date et son motif éventuel. */
export interface TerminationRequest {
  origin: TerminationOrigin;
  requestedBy: string;
  requestedAt: Date;
  reason: string | null;
}

/** Ce que montre un abonnement, à son titulaire comme à la gestion. */
interface SubscriptionView {
  id: string;
  offer: string;
  teamAlias: string;
  accountEmail: string;
  accountOutsideLinagora: boolean;
  subscribedAt: Date;
  monthlyAmountEur: number;
  expiresAt: Date;
  status: "ACTIF" | "A_RESILIER" | "RESILIE";
  /** Demande de résiliation, en cours (« à résilier ») ou qui a précédé la résiliation ; null sans demande. */
  termination: TerminationRequest | null;
  /** Date de résiliation, pour un abonnement résilié. */
  terminatedOn: Date | null;
}

/** Abonnement tel que le voit son titulaire, avec son fournisseur et ce qu'il peut en demander (ticket #59). */
export interface MySubscription extends SubscriptionView {
  supplier: string;
  /** Renouvellement possible : abonnement non résilié, à un mois ou moins de son échéance, sans autre demande en cours. */
  canRenew: boolean;
  /** Changement d'offre possible : abonnement non résilié, sans autre demande en cours. */
  canChangeOffer: boolean;
  /** Demande de renouvellement ou de changement d'offre en cours sur cet abonnement. */
  pendingRequest: { id: string; type: "RENOUVELLEMENT" | "CHANGEMENT_OFFRE" } | null;
}

/** Abonnement tel que le voit la gestion, avec son titulaire et ses prélèvements, du plus ancien au plus récent. */
export interface AdminSubscription extends SubscriptionView {
  holderUid: string;
  holderEmail: string;
  charges: { chargedOn: Date; amountEur: number; teamAlias: string }[];
}

/** Abonnement approuvé qui attend la déclaration de son titulaire, vu par la gestion. */
export interface AdminSubscriptionToDeclare {
  requestId: string;
  holderUid: string;
  holderEmail: string;
  teamAlias: string;
  offer: string;
  approvedAt: Date | null;
  declarationDeadline: Date | null;
}

type AbonnementAvecOffre = Subscription & { offer: Pick<SubscriptionOffer, "supplier" | "name"> };

/** Abonnement lu par la gestion, avec son offre et ses prélèvements. */
const AVEC_PRELEVEMENTS = { offer: true, charges: { orderBy: { chargedOn: "asc" } } } as const;

/** Vue commune d'un abonnement. */
function vueAbonnement(a: AbonnementAvecOffre): SubscriptionView {
  return {
    id: a.id,
    offer: libelleOffre(a.offer),
    teamAlias: a.teamAlias,
    accountEmail: a.accountEmail,
    accountOutsideLinagora: horsLinagora(a.accountEmail),
    subscribedAt: a.subscribedAt,
    monthlyAmountEur: a.monthlyAmountEur.toNumber(),
    expiresAt: a.expiresAt,
    status: a.status,
    termination:
      a.terminationOrigin && a.terminationRequestedBy && a.terminationRequestedAt
        ? { origin: a.terminationOrigin, requestedBy: a.terminationRequestedBy, requestedAt: a.terminationRequestedAt, reason: a.terminationReason }
        : null,
    terminatedOn: a.terminatedOn,
  };
}

const vueGestion = (a: AbonnementAvecOffre & { charges: SubscriptionCharge[] }): AdminSubscription => ({
  ...vueAbonnement(a),
  holderUid: a.holderUid,
  holderEmail: a.holderEmail,
  charges: a.charges.map((c) => ({ chargedOn: c.chargedOn, amountEur: c.amountEur.toNumber(), teamAlias: c.teamAlias })),
});

/** « Mes abonnements » : les abonnements approuvés à déclarer, puis les abonnements déclarés, du plus récent au plus ancien. */
export async function listMySubscriptions(deps: SubscriptionDeps, user: SessionUser): Promise<{ aDeclarer: SubscriptionToDeclare[]; abonnements: MySubscription[] }> {
  await markExpired(deps.db, deps.now?.() ?? new Date());
  const [demandes, abonnements, delai, enCours] = await Promise.all([
    deps.db.accessRequest.findMany({ where: { requesterUid: user.uid, kind: "ABONNEMENT", status: "APPROUVEE" }, include: { offer: true }, orderBy: { decidedAt: "asc" } }),
    deps.db.subscription.findMany({ where: { holderUid: user.uid }, include: { offer: true }, orderBy: [{ subscribedAt: "desc" }, { id: "desc" }] }),
    readPickupDays(deps.db),
    deps.db.accessRequest.findMany({
      where: { requesterUid: user.uid, OR: [{ renewsSubscriptionId: { not: null } }, { replacesSubscriptionId: { not: null } }], ...DEMANDE_SUR_ABONNEMENT_EN_COURS },
    }),
  ]);
  const maintenant = deps.now?.() ?? new Date();
  const demandeEnCours = (id: string): MySubscription["pendingRequest"] => {
    const demande = enCours.find((d) => d.renewsSubscriptionId === id || d.replacesSubscriptionId === id);
    return demande ? { id: demande.id, type: demande.renewsSubscriptionId ? "RENOUVELLEMENT" : "CHANGEMENT_OFFRE" } : null;
  };
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
    abonnements: abonnements.map((a) => {
      const pendingRequest = demandeEnCours(a.id);
      const ouvert = a.status !== "RESILIE" && !pendingRequest;
      return {
        ...vueAbonnement(a),
        supplier: a.offer.supplier,
        canRenew: ouvert && renouvelableLe(a, maintenant),
        canChangeOffer: ouvert,
        pendingRequest,
      };
    }),
  };
}

/**
 * Le titulaire déclare l'abonnement approuvé qu'il a souscrit : la demande passe « Déclarée » et l'abonnement naît,
 * actif. Son échéance court sur la durée approuvée à partir de la souscription, ou de l'approbation pour un abonnement
 * souscrit avant elle (régularisation). Une date de souscription future est refusée.
 */
export async function declareSubscription(deps: SubscriptionDeps, user: SessionUser, requestId: string, input: DeclarationInput): Promise<string> {
  const data = declarationInputSchema.parse(input);
  const maintenant = deps.now?.() ?? new Date();
  const souscription = new Date(`${data.subscribedAt}T00:00:00Z`);
  if (souscription > jourUtc(maintenant)) {
    throw new PortalError("date_future", "La date de souscription ne peut pas être dans le futur.");
  }
  // Comme au retrait d'une clé : une demande dont le délai est passé expire d'abord, et ne se déclare plus.
  await markExpired(deps.db, maintenant);
  const request = await deps.db.accessRequest.findUnique({ where: { id: requestId }, include: { offer: true } });
  if (!request || request.requesterUid !== user.uid || request.kind !== "ABONNEMENT" || !request.offer) {
    throw new PortalError("introuvable", "Demande d'abonnement introuvable.", { objet: "demande_abonnement" });
  }
  const { offer } = request;
  if (request.status === "EXPIREE") {
    throw new PortalError("transition_interdite", "Le délai de déclaration est passé : la demande a expiré.", { cas: "declaration_expiree" });
  }
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
  // Une souscription passée (régularisation) compte d'un coup les prélèvements déjà échus.
  await enregistrerPrelevements(deps.db, abonnement, maintenant);
  await recordAudit(deps.db, {
    actorUid: user.uid,
    action: "SUBSCRIPTION_DECLARED",
    targetId: abonnement.id,
    details: { offre: libelleOffre(offer), montant: data.monthlyAmountEur, compteHorsLinagora: horsLinagora(data.accountEmail) },
  });
  if (request.replacesSubscriptionId) await resilierLAbonnementRemplace(deps, user, request.replacesSubscriptionId, abonnement);
  return abonnement.id;
}

/**
 * Changement d'offre (ticket #59) : à la déclaration de la nouvelle offre, l'abonnement remplacé, et lui seul, est
 * résilié à la date de souscription déclarée (au plus tôt à sa propre souscription). Inscrit au journal.
 */
async function resilierLAbonnementRemplace(deps: SubscriptionDeps, user: SessionUser, remplaceId: string, nouveau: Subscription): Promise<void> {
  const remplace = await deps.db.subscription.findUnique({ where: { id: remplaceId }, include: { offer: true } });
  if (!remplace || remplace.status === "RESILIE") return;
  const date = new Date(Math.max(nouveau.subscribedAt.getTime(), remplace.subscribedAt.getTime()));
  await enregistrerResiliation(deps.db, remplace, date, deps.now?.() ?? new Date());
  const nouvelle = await deps.db.subscriptionOffer.findUniqueOrThrow({ where: { id: nouveau.offerId } });
  await recordAudit(deps.db, {
    actorUid: user.uid,
    action: "SUBSCRIPTION_OFFER_CHANGED",
    targetId: remplace.id,
    details: { offre: libelleOffre(remplace.offer), nouvelleOffre: libelleOffre(nouvelle), date: date.toISOString().slice(0, 10), nouvelAbonnement: nouveau.id },
  });
}

/** Montant mensuel corrigé par le titulaire (hausse de prix, change) : en euros TTC, positif. */
export const amountCorrectionSchema = z.object({ monthlyAmountEur: z.number().positive() });

export type AmountCorrection = z.infer<typeof amountCorrectionSchema>;

/**
 * Le titulaire corrige le montant mensuel de son abonnement (ticket #57) : la correction vaut à partir du prélèvement
 * suivant, et elle est inscrite au journal d'audit.
 */
export async function correctSubscriptionAmount(deps: SubscriptionDeps, user: SessionUser, subscriptionId: string, input: AmountCorrection): Promise<void> {
  const { monthlyAmountEur } = amountCorrectionSchema.parse(input);
  const abonnement = await deps.db.subscription.findUnique({ where: { id: subscriptionId } });
  if (!abonnement || abonnement.holderUid !== user.uid || abonnement.status === "RESILIE") {
    throw new PortalError("introuvable", "Abonnement introuvable.", { objet: "abonnement" });
  }
  // Les prélèvements déjà échus gardent l'ancien montant, même si la tâche quotidienne ne les a pas encore comptés.
  await enregistrerPrelevements(deps.db, abonnement, deps.now?.() ?? new Date());
  await deps.db.subscription.update({ where: { id: abonnement.id }, data: { monthlyAmountEur } });
  await recordAudit(deps.db, {
    actorUid: user.uid,
    action: "SUBSCRIPTION_AMOUNT_CORRECTED",
    targetId: abonnement.id,
    details: { ancien: abonnement.monthlyAmountEur.toNumber(), nouveau: monthlyAmountEur },
  });
}

/**
 * Gestion (spécification #51) : abonnements approuvés en attente de déclaration, de la plus ancienne approbation à la
 * plus récente ; pour un responsable, ceux de ses équipes ; avec `teamId`, ceux de cette seule équipe.
 */
export async function listSubscriptionsToDeclare(deps: SubscriptionDeps, actor: SessionUser, teamId?: string): Promise<AdminSubscriptionToDeclare[]> {
  const equipes = await requireGestion(deps.db, actor);
  await markExpired(deps.db, deps.now?.() ?? new Date());
  const [demandes, delai] = await Promise.all([
    deps.db.accessRequest.findMany({ where: { kind: "ABONNEMENT", status: "APPROUVEE", ...dansEquipes(equipes, teamId) }, include: { offer: true }, orderBy: { decidedAt: "asc" } }),
    readPickupDays(deps.db),
  ]);
  return demandes.flatMap((d) =>
    d.offer
      ? [
          {
            requestId: d.id,
            holderUid: d.requesterUid,
            holderEmail: d.requesterEmail,
            teamAlias: d.teamAlias,
            offer: libelleOffre(d.offer),
            approvedAt: d.decidedAt,
            declarationDeadline: delai !== null && d.decidedAt ? pickupDeadline(d.decidedAt, delai) : null,
          },
        ]
      : [],
  );
}

/** Gestion : abonnements actifs ou à résilier (mêmes filtres), du plus récemment souscrit au plus ancien. */
export async function listActiveSubscriptions(deps: SubscriptionDeps, actor: SessionUser, teamId?: string): Promise<AdminSubscription[]> {
  const equipes = await requireGestion(deps.db, actor);
  const abonnements = await deps.db.subscription.findMany({
    where: { status: { not: "RESILIE" }, ...dansEquipes(equipes, teamId) },
    include: AVEC_PRELEVEMENTS,
    orderBy: [{ subscribedAt: "desc" }, { id: "desc" }],
  });
  return abonnements.map(vueGestion);
}

/** Gestion : archive des abonnements résiliés (mêmes filtres), par pages de PAR_PAGE, le plus récemment résilié d'abord. */
export async function listSubscriptionArchive(deps: SubscriptionDeps, actor: SessionUser, page = 1, teamId?: string): Promise<Page<AdminSubscription>> {
  const equipes = await requireGestion(deps.db, actor);
  const where = { status: "RESILIE" as const, ...dansEquipes(equipes, teamId) };
  const total = await deps.db.subscription.count({ where });
  const { page: courante, pages, skip, take } = tranche(total, page);
  const rows = await deps.db.subscription.findMany({ where, include: AVEC_PRELEVEMENTS, orderBy: [{ terminatedOn: "desc" }, { updatedAt: "desc" }, { id: "desc" }], skip, take });
  return { elements: rows.map(vueGestion), page: courante, pages, total };
}
