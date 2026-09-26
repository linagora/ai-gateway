import { z } from "zod";
import type { Prisma, RequestKind } from "@/generated/prisma/client";
import type { SessionUser } from "@/lib/auth-user";
import type { Db } from "@/lib/db";
import { DUREES_ABONNEMENT, PERIODE_BUDGET } from "@/lib/durees";
import { PolicyViolationError, PortalError } from "@/lib/errors";
import type { LiteLLMClient } from "@/lib/litellm/client";
import { type Page, tranche } from "@/lib/pagination";
import type { DataLevel, PolicyCheck, RequestStatus } from "@/lib/policy";
import { recordAudit } from "./audit";
import { dansEquipes, managerEmails, requireAutorite, requireGestion } from "./autorite";
import { pickupDeadline, readPickupDays } from "./delais";
import { markExpired } from "./echeances";
import {
  type NotificationDeps,
  notifyCompletionRequested,
  notifyKeyApproved,
  notifyMembershipApproved,
  notifyRefused,
  notifyRenewalApproved,
  notifySubscriptionApproved,
  notifyTeamChange,
} from "./notifications";
import { libelleOffre } from "./offers";
import { reporterEcheance } from "./renouvellements";
import { evaluateKeyRequest, transitionRequest } from "./requests";
import { requestTerminationAfterRefusedRenewal } from "./resiliations";
import { readSettings, type SettingValues } from "./settings";

interface AdminDeps extends NotificationDeps {
  db: Db;
  litellm: LiteLLMClient;
  /** Date du jour, injectée par les tests ; l'heure réelle sinon. */
  now?: () => Date;
}

/** Ligne de la file de validation (F-30). */
export interface PendingRequest {
  id: string;
  kind: RequestKind;
  /** Demande d'abonnement : l'offre demandée, « Anthropic · Claude Max 5x ». */
  offer: string | null;
  requesterUid: string;
  teamAlias: string;
  dataLevel: DataLevel | null;
  models: string[];
  project: string | null;
  status: RequestStatus;
  createdAt: Date;
}

/** F-30 : demandes en attente, de la plus ancienne à la plus récente ; pour un responsable, celles de ses équipes. */
export async function listPendingRequests(deps: AdminDeps, actor: SessionUser): Promise<PendingRequest[]> {
  const equipes = await requireGestion(deps.db, actor);
  const rows = await deps.db.accessRequest.findMany({ where: { status: "SOUMISE", ...dansEquipes(equipes) }, orderBy: { createdAt: "asc" }, include: { offer: true } });
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    offer: r.offer && libelleOffre(r.offer),
    requesterUid: r.requesterUid,
    teamAlias: r.teamAlias,
    dataLevel: r.dataLevel,
    models: r.models,
    project: r.project,
    status: r.status,
    createdAt: r.createdAt,
  }));
}

/**
 * Pastilles du menu de gestion : demandes à valider, et clés approuvées que leur titulaire n'a pas retirées. Pour un
 * responsable, celles de ses équipes, hors ses propres demandes, qu'il ne valide pas.
 */
export async function countAdminPending(
  deps: AdminDeps,
  actor: SessionUser,
): Promise<{ demandes: number; clesARetirer: number; abonnementsADeclarer: number }> {
  const equipes = await requireGestion(deps.db, actor);
  await markExpired(deps.db, deps.now?.() ?? new Date());
  const siennes = equipes === null ? {} : { requesterUid: { not: actor.uid } };
  const [demandes, clesARetirer, abonnementsADeclarer] = await Promise.all([
    deps.db.accessRequest.count({ where: { status: "SOUMISE", ...dansEquipes(equipes), ...siennes } }),
    deps.db.accessRequest.count({ where: { kind: "CLE", status: "APPROUVEE", ...dansEquipes(equipes) } }),
    deps.db.accessRequest.count({ where: { kind: "ABONNEMENT", status: "APPROUVEE", ...dansEquipes(equipes) } }),
  ]);
  return { demandes, clesARetirer, abonnementsADeclarer };
}

/** Demande traitée, telle que l'archive la présente : avec la décision et son auteur. */
export interface ProcessedRequest extends PendingRequest {
  decidedAt: Date | null;
  decidedBy: string | null;
  decisionComment: string | null;
  updatedAt: Date;
}

/**
 * Archive des demandes (F-30) : celles qui ne sont plus à valider, la plus récemment modifiée d'abord, par pages de
 * PAR_PAGE ; une page hors limites mène à la plus proche.
 */
export async function listProcessedRequests(deps: AdminDeps, actor: SessionUser, page = 1): Promise<Page<ProcessedRequest>> {
  const equipes = await requireGestion(deps.db, actor);
  await markExpired(deps.db, deps.now?.() ?? new Date());
  const where: Prisma.AccessRequestWhereInput = { status: { not: "SOUMISE" }, ...dansEquipes(equipes) };
  const total = await deps.db.accessRequest.count({ where });
  const { page: courante, pages, skip, take } = tranche(total, page);
  const rows = await deps.db.accessRequest.findMany({
    where,
    // L'identifiant départage les demandes modifiées au même instant : une page ne répète ni ne saute aucune demande.
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    skip,
    take,
    include: { offer: true },
  });
  const elements = rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    offer: r.offer && libelleOffre(r.offer),
    requesterUid: r.requesterUid,
    teamAlias: r.teamAlias,
    dataLevel: r.dataLevel,
    models: r.approvedModels.length > 0 ? r.approvedModels : r.models,
    project: r.project,
    status: r.status,
    createdAt: r.createdAt,
    decidedAt: r.decidedAt,
    decidedBy: r.decidedBy,
    decisionComment: r.decisionComment,
    updatedAt: r.updatedAt,
  }));
  return { elements, page: courante, pages, total };
}

/** Fiche de validation (F-32) : la demande et ses contrôles, rejoués avec l'état actuel (règle 4). */
export interface RequestReview extends PendingRequest {
  requesterEmail: string;
  /** Demande d'abonnement : l'offre demandée, avec son prix mensuel TTC et son niveau maximal. */
  subscriptionOffer: { supplier: string; name: string; monthlyPriceEur: number; dataLevel: DataLevel } | null;
  /** Durée de validité accordée, en jours (clé ou abonnement), null tant que la demande n'est pas approuvée. */
  approvedDays: number | null;
  /** Demande d'abonnement : les abonnements en cours (non résiliés) du demandeur, pour décider en connaissance de cause. */
  requesterSubscriptions: { offer: string; teamAlias: string; subscribedAt: Date; monthlyAmountEur: number }[];
  /** Renouvellement d'un abonnement (ticket #59) : l'abonnement renouvelé, avec son échéance en cours. */
  renewedSubscription: { id: string; offer: string; expiresAt: Date } | null;
  /** Changement d'offre (ticket #59) : l'abonnement remplacé. */
  replacedSubscription: { id: string; offer: string } | null;
  teamId: string;
  justification: string;
  requestedBudget: number | null;
  requestedDays: number | null;
  decidedBy: string | null;
  decisionComment: string | null;
  /** Paramètres figés à l'approbation (F-40), null tant que la demande n'est pas approuvée. */
  approved: ApprovalInput | null;
  checks: PolicyCheck[];
  /** Renouvellement : alias de la clé d'origine et sa dépense (null si elle a été révoquée ou si la passerelle ne répond pas). */
  renewal: { alias: string; spend: number | null } | null;
}

export async function getRequestReview(deps: AdminDeps, actor: SessionUser, id: string): Promise<RequestReview> {
  await requireGestion(deps.db, actor);
  await markExpired(deps.db, deps.now?.() ?? new Date());
  const r = await deps.db.accessRequest.findUnique({ where: { id }, include: { offer: true } });
  if (!r) throw new PortalError("introuvable", "Demande introuvable.", { objet: "demande" });
  await requireAutorite(deps.db, actor, r.teamId, "demande");
  const abonnements =
    r.kind === "ABONNEMENT"
      ? await deps.db.subscription.findMany({ where: { holderUid: r.requesterUid, status: { not: "RESILIE" } }, include: { offer: true }, orderBy: { subscribedAt: "asc" } })
      : [];
  const [renouvele, remplace] = await Promise.all(
    [r.renewsSubscriptionId, r.replacesSubscriptionId].map((id) => (id ? deps.db.subscription.findUnique({ where: { id }, include: { offer: true } }) : null)),
  );
  const checks =
    r.kind === "CLE" && r.dataLevel
      ? (await evaluateKeyRequest(deps, { requesterUid: r.requesterUid, teamId: r.teamId, dataLevel: r.dataLevel, models: r.models })).checks
      : [];
  return {
    id: r.id,
    kind: r.kind,
    offer: r.offer && libelleOffre(r.offer),
    subscriptionOffer: r.offer && { supplier: r.offer.supplier, name: r.offer.name, monthlyPriceEur: r.offer.monthlyPriceEur.toNumber(), dataLevel: r.offer.dataLevel },
    approvedDays: r.approvedDays,
    requesterSubscriptions: abonnements.map((a) => ({ offer: libelleOffre(a.offer), teamAlias: a.teamAlias, subscribedAt: a.subscribedAt, monthlyAmountEur: a.monthlyAmountEur.toNumber() })),
    renewedSubscription: renouvele && { id: renouvele.id, offer: libelleOffre(renouvele.offer), expiresAt: renouvele.expiresAt },
    replacedSubscription: remplace && { id: remplace.id, offer: libelleOffre(remplace.offer) },
    requesterUid: r.requesterUid,
    requesterEmail: r.requesterEmail,
    teamId: r.teamId,
    teamAlias: r.teamAlias,
    dataLevel: r.dataLevel,
    models: r.models,
    project: r.project,
    justification: r.justification,
    requestedBudget: r.requestedBudget?.toNumber() ?? null,
    requestedDays: r.requestedDays,
    status: r.status,
    createdAt: r.createdAt,
    decidedBy: r.decidedBy,
    decisionComment: r.decisionComment,
    approved: r.decidedAt && r.approvedModels.length
      ? {
          models: r.approvedModels,
          budget: r.approvedBudget?.toNumber() ?? null,
          budgetDuration: r.budgetDuration,
          days: r.approvedDays,
          rpmLimit: r.rpmLimit,
          tpmLimit: r.tpmLimit,
        }
      : null,
    checks,
    renewal: r.renewsRequestId ? await renewalOrigin(deps, r.renewsRequestId) : null,
  };
}

async function renewalOrigin(deps: AdminDeps, requestId: string): Promise<RequestReview["renewal"]> {
  const origine = await deps.db.accessRequest.findUnique({ where: { id: requestId } });
  if (!origine?.keyAlias) return null;
  // Une clé expirée reste connue de la passerelle, avec sa dépense ; une clé révoquée en a été supprimée.
  const lisible = (origine.status === "CLE_EMISE" || origine.status === "EXPIREE") && origine.keyTokenId;
  const info = lisible ? await deps.litellm.getKeyInfo(lisible).catch(() => null) : null;
  return { alias: origine.keyAlias, spend: info?.spend ?? null };
}

/** Paramètres de la clé fixés par l'admin (F-31). Durées au format LiteLLM : 30d, 12h… */
export const approvalInputSchema = z.object({
  /** Équipe de la clé : celle de la demande, sauf si l'admin en choisit une autre. */
  teamId: z.string().min(1).optional(),
  models: z.array(z.string().min(1)),
  budget: z.number().positive().nullable(),
  budgetDuration: z.string().regex(PERIODE_BUDGET).nullable(),
  /** Durée de validité en jours ; SANS_EXPIRATION (0) : la clé n'expire jamais. */
  days: z.number().int().nonnegative().nullable(),
  rpmLimit: z.number().int().positive().nullable(),
  tpmLimit: z.number().int().positive().nullable(),
});

export type ApprovalInput = z.infer<typeof approvalInputSchema>;

/**
 * F-31 : approuve une demande de clé en figeant ses paramètres (statut APPROUVEE). L'admin peut rattacher
 * la clé à une autre équipe : les contrôles sont rejoués pour celle-ci, et l'approbation y ajoute le
 * demandeur s'il n'en est pas membre (décision du 2026-09-25).
 */
export async function approveKeyRequest(deps: AdminDeps, actor: SessionUser, id: string, input: ApprovalInput): Promise<void> {
  await requireGestion(deps.db, actor);
  const params = withDefaults(approvalInputSchema.parse(input), await readSettings(deps.db));
  if (params.budget === null || params.budgetDuration === null || params.days === null) {
    throw new PortalError(
      "parametre_manquant",
      "Budget, période du budget et durée de validité sont obligatoires : saisissez-les ou configurez des valeurs par défaut.",
    );
  }
  const request = await deps.db.accessRequest.findUnique({ where: { id } });
  if (!request || request.kind !== "CLE" || !request.dataLevel) throw new PortalError("introuvable", "Demande de clé introuvable.", { objet: "demande_cle" });
  await requireDecision(deps, actor, request, "demande_cle");
  const equipe = await teamForApproval(deps, actor, request, params.teamId);
  const reaffectee = equipe.teamId !== request.teamId;
  const draft = { requesterUid: request.requesterUid, teamId: equipe.teamId, dataLevel: request.dataLevel, models: params.models };
  const verdict = await evaluateKeyRequest(deps, draft);
  // Dans une équipe choisie par l'admin, l'approbation vaut adhésion : l'appartenance n'y est pas exigée.
  const bloquants = verdict.checks.filter((c) => !c.ok && !(reaffectee && c.id === "membre_equipe"));
  if (bloquants.length > 0) throw new PolicyViolationError(bloquants);
  if (verdict.checks.some((c) => c.id === "membre_equipe" && !c.ok)) await ajouterMembre(deps.litellm, equipe.teamId, request.requesterUid);
  const approuveeLe = deps.now?.() ?? new Date();
  await transitionRequest(deps.db, request, "APPROUVEE", {
    data: {
      ...equipe,
      approvedModels: params.models,
      approvedBudget: params.budget,
      budgetDuration: params.budgetDuration,
      approvedDays: params.days,
      rpmLimit: params.rpmLimit,
      tpmLimit: params.tpmLimit,
      decidedBy: actor.uid,
      decidedAt: approuveeLe,
    },
  });
  await recordAudit(deps.db, { actorUid: actor.uid, action: "REQUEST_APPROVED", targetId: request.id, details: { teamAlias: equipe.teamAlias } });
  const [approuvee, delai] = await Promise.all([deps.db.accessRequest.findUniqueOrThrow({ where: { id: request.id } }), readPickupDays(deps.db)]);
  await notifyKeyApproved(deps, approuvee, delai !== null ? pickupDeadline(approuveeLe, delai) : null);
  await annoncerDecision(deps, actor, { ...request, ...equipe }, "approuvee");
}

/** Règle 7 : les paramètres non saisis prennent les valeurs par défaut configurées (F-51). */
function withDefaults(params: ApprovalInput, settings: SettingValues): ApprovalInput {
  const num = (value: string | undefined) => (value === undefined ? null : Number(value));
  return {
    teamId: params.teamId,
    models: params.models,
    budget: params.budget ?? num(settings.default_budget),
    budgetDuration: params.budgetDuration ?? settings.default_budget_duration ?? null,
    days: params.days ?? num(settings.default_days),
    rpmLimit: params.rpmLimit ?? num(settings.default_rpm),
    tpmLimit: params.tpmLimit ?? num(settings.default_tpm),
  };
}

/** F-31 : refuse une demande ; le motif est obligatoire et visible du demandeur. */
export async function refuseRequest(deps: AdminDeps, actor: SessionUser, id: string, comment: string): Promise<void> {
  await requireGestion(deps.db, actor);
  const request = await deps.db.accessRequest.findUnique({ where: { id }, include: { offer: true } });
  if (!request) throw new PortalError("introuvable", "Demande introuvable.", { objet: "demande" });
  await requireDecision(deps, actor, request, "demande");
  await transitionRequest(deps.db, request, "REFUSEE", {
    comment,
    data: { decidedBy: actor.uid, decidedAt: new Date(), decisionComment: comment.trim() },
  });
  await recordAudit(deps.db, { actorUid: actor.uid, action: "REQUEST_REFUSED", targetId: request.id, details: { motif: comment.trim() } });
  await notifyRefused(deps, request, comment.trim());
  await annoncerDecision(deps, actor, request, "refusee");
  // Ticket #59 : refusé, le renouvellement d'un abonnement en fait une demande de résiliation.
  if (request.renewsSubscriptionId) await requestTerminationAfterRefusedRenewal(deps, actor, request.renewsSubscriptionId, comment.trim());
}

/** F-31 : renvoie la demande au demandeur pour qu'il la complète (statut A_COMPLETER). */
export async function requestCompletion(deps: AdminDeps, actor: SessionUser, id: string, comment: string): Promise<void> {
  await requireGestion(deps.db, actor);
  const request = await deps.db.accessRequest.findUnique({ where: { id }, include: { offer: true } });
  if (!request) throw new PortalError("introuvable", "Demande introuvable.", { objet: "demande" });
  await requireDecision(deps, actor, request, "demande");
  await transitionRequest(deps.db, request, "A_COMPLETER", {
    data: { decidedBy: actor.uid, decidedAt: new Date(), decisionComment: comment.trim() || null },
  });
  await recordAudit(deps.db, { actorUid: actor.uid, action: "COMPLETION_REQUESTED", targetId: request.id, details: { commentaire: comment.trim() || null } });
  await notifyCompletionRequested(deps, request, comment.trim() || null);
  await annoncerDecision(deps, actor, request, "complement");
}

/**
 * F-22 : approuve une demande d'adhésion en ajoutant le demandeur dans LiteLLM à l'équipe demandée, ou à
 * celle que choisit l'admin (réaffectation). LiteLLM d'abord : en cas d'échec, la demande reste SOUMISE.
 */
export async function approveTeamJoinRequest(deps: AdminDeps, actor: SessionUser, id: string, teamId?: string): Promise<void> {
  await requireGestion(deps.db, actor);
  const request = await deps.db.accessRequest.findUnique({ where: { id } });
  if (!request || request.kind !== "ADHESION_EQUIPE") throw new PortalError("introuvable", "Demande d'adhésion introuvable.", { objet: "demande_adhesion" });
  await requireDecision(deps, actor, request, "demande_adhesion");
  if (request.status !== "SOUMISE") throw new PortalError("transition_interdite", "Cette demande a déjà été traitée.", { cas: "traitee" });
  const equipe = await teamForApproval(deps, actor, request, teamId);
  await ajouterMembre(deps.litellm, equipe.teamId, request.requesterUid);
  await transitionRequest(deps.db, request, "APPROUVEE", { data: { ...equipe, decidedBy: actor.uid, decidedAt: new Date() } });
  await recordAudit(deps.db, { actorUid: actor.uid, action: "MEMBERSHIP_APPROVED", targetId: request.id, details: { teamAlias: equipe.teamAlias } });
  await notifyMembershipApproved(deps, request, equipe.teamAlias);
  await annoncerDecision(deps, actor, { ...request, ...equipe }, "adhesion");
}

/** Durée de validité accordée à un abonnement (spécification #51) : de 1 mois à 1 an. */
export const subscriptionApprovalSchema = z.object({ days: z.number().refine((jours) => (DUREES_ABONNEMENT as readonly number[]).includes(jours)) });

/**
 * Spécification #51 : approuve une demande d'abonnement en fixant sa durée de validité. Le demandeur apprend comment
 * souscrire, puis déclarer l'abonnement dans le délai de retrait ; la décision est annoncée selon les règles des équipes.
 * Un renouvellement (ticket #59) s'applique aussitôt : l'échéance de l'abonnement est reportée de la durée approuvée,
 * sans nouvelle déclaration.
 */
export async function approveSubscriptionRequest(deps: AdminDeps, actor: SessionUser, id: string, input: { days: number }): Promise<void> {
  await requireGestion(deps.db, actor);
  const { days } = subscriptionApprovalSchema.parse(input);
  const request = await deps.db.accessRequest.findUnique({ where: { id }, include: { offer: true } });
  if (!request || request.kind !== "ABONNEMENT" || !request.offer) throw new PortalError("introuvable", "Demande d'abonnement introuvable.", { objet: "demande_abonnement" });
  await requireDecision(deps, actor, request, "demande_abonnement");
  if (request.status !== "SOUMISE") throw new PortalError("transition_interdite", "Cette demande a déjà été traitée.", { cas: "traitee" });
  const [renouvele, remplace] = await Promise.all(
    [request.renewsSubscriptionId, request.replacesSubscriptionId].map((id) => (id ? deps.db.subscription.findUnique({ where: { id }, include: { offer: true } }) : null)),
  );
  if (request.renewsSubscriptionId && (!renouvele || renouvele.status === "RESILIE")) {
    throw new PortalError("transition_interdite", "L'abonnement à renouveler est résilié.", { cas: "abonnement" });
  }
  const approuveeLe = deps.now?.() ?? new Date();
  await transitionRequest(deps.db, request, "APPROUVEE", { data: { approvedDays: days, decidedBy: actor.uid, decidedAt: approuveeLe } });
  if (renouvele) {
    const echeance = await reporterEcheance(deps.db, renouvele, days);
    await transitionRequest(deps.db, { id: request.id, status: "APPROUVEE" }, "RENOUVELEE");
    await recordAudit(deps.db, {
      actorUid: actor.uid,
      action: "REQUEST_APPROVED",
      targetId: request.id,
      details: { kind: "ABONNEMENT", offre: libelleOffre(request.offer), jours: days, echeance: echeance.toISOString().slice(0, 10) },
    });
    await notifyRenewalApproved(deps, request, request.offer, echeance);
  } else {
    await recordAudit(deps.db, { actorUid: actor.uid, action: "REQUEST_APPROVED", targetId: request.id, details: { kind: "ABONNEMENT", offre: libelleOffre(request.offer), jours: days } });
    const delai = await readPickupDays(deps.db);
    const echeanceDeDeclaration = delai !== null ? pickupDeadline(approuveeLe, delai) : null;
    await notifySubscriptionApproved(deps, { ...request, approvedDays: days }, request.offer, echeanceDeDeclaration, remplace && libelleOffre(remplace.offer));
  }
  await annoncerDecision(deps, actor, request, "abonnement");
}

/**
 * Ajoute le salarié à l'équipe dans LiteLLM. Déjà membre (demande en double, ajout depuis la console), il n'y a rien
 * à faire : LiteLLM refuserait le doublon. Un autre échec est une indisponibilité de la passerelle, sans détail.
 */
async function ajouterMembre(litellm: LiteLLMClient, teamId: string, uid: string): Promise<void> {
  const membre = async () => (await litellm.getTeam(teamId).catch(() => null))?.memberUids.includes(uid) ?? false;
  if (await membre()) return;
  try {
    await litellm.addTeamMember(teamId, uid);
  } catch {
    if (!(await membre())) throw new PortalError("passerelle_indisponible", "L'ajout à l'équipe a échoué.");
  }
}

/**
 * Équipe retenue à l'approbation : celle de la demande, sauf si le valideur en choisit une autre, qui doit exister et,
 * pour un responsable d'équipe, être une équipe qu'il gère.
 */
async function teamForApproval(
  deps: AdminDeps,
  actor: SessionUser,
  request: { teamId: string; teamAlias: string },
  teamId: string | undefined,
): Promise<{ teamId: string; teamAlias: string }> {
  if (!teamId || teamId === request.teamId) return { teamId: request.teamId, teamAlias: request.teamAlias };
  await requireAutorite(deps.db, actor, teamId, "equipe");
  const team = await deps.litellm.getTeam(teamId);
  if (!team) throw new PortalError("introuvable", `Équipe introuvable : ${teamId}.`, { objet: "equipe" });
  return { teamId: team.teamId, teamAlias: team.teamAlias };
}

/**
 * Droit de décider d'une demande (F-54) : autorité sur son équipe (admin, ou responsable de cette équipe) et, pour un
 * responsable, jamais sur sa propre demande : un autre responsable de l'équipe ou un admin en décide.
 */
async function requireDecision(deps: AdminDeps, actor: SessionUser, request: { teamId: string; requesterUid: string }, objet: string): Promise<void> {
  await requireAutorite(deps.db, actor, request.teamId, objet);
  if (!actor.isAdmin && request.requesterUid === actor.uid) {
    throw new PortalError("quatre_yeux", "Un responsable ne décide pas de sa propre demande.", { cas: "demande" });
  }
}

/**
 * Une décision est annoncée aux responsables de l'équipe, hors son auteur et le demandeur, et, celle d'un responsable,
 * aux admins (F-54).
 */
async function annoncerDecision(
  deps: AdminDeps,
  actor: SessionUser,
  request: { id: string; teamId: string; teamAlias: string; requesterUid: string },
  decision: "approuvee" | "refusee" | "complement" | "adhesion" | "abonnement",
): Promise<void> {
  await notifyTeamChange(
    deps,
    { type: "decision", decision, demandeur: request.requesterUid, demandeId: request.id, teamId: request.teamId, equipe: request.teamAlias, auteur: actor },
    // Le demandeur, fût-il responsable, reçoit déjà la décision sur sa demande.
    await managerEmails(deps.db, request.teamId, [actor.uid, request.requesterUid]),
  );
}
