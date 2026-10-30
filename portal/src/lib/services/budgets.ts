import { z } from "zod";
import type { AccessRequest, Prisma } from "@/generated/prisma/client";
import type { SessionUser } from "@/lib/auth-user";
import type { Db } from "@/lib/db";
import { PortalError } from "@/lib/errors";
import { enAttenteDeValidation, STATUTS_PAS_ENCORE_DECIDES } from "@/lib/policy";
import { type AdminDeps, annoncerDecision, requireDecision } from "./admin-requests";
import { parActeur, recordAudit } from "./audit";
import { managerEmails, requireGestion } from "./autorite";
import { hausseEnCours } from "./demandes-en-cours";
import { notifyBudgetRaised, notifyNewBudgetRequest } from "./notifications";
import { transitionRequest } from "./requests";

/** Demande de hausse du budget d'une clé émise : nouveau plafond, strictement au-dessus de l'actuel, et justification. */
export const budgetRaiseInputSchema = z.object({
  keyRequestId: z.string().min(1),
  requestedBudget: z.number().positive(),
  justification: z.string().trim().min(1),
});

export type BudgetRaiseInput = z.infer<typeof budgetRaiseInputSchema>;

const complementSchema = budgetRaiseInputSchema.omit({ keyRequestId: true });

const approbationSchema = z.object({ budget: z.number().positive() });

/**
 * Hausse du budget d'une clé émise : le titulaire demande un plafond plus haut pour sa clé encore émise et non expirée,
 * sans renouvellement en cours ni autre hausse en cours (une seule par clé). La demande suit le circuit d'une demande de
 * clé : les admins et les responsables de l'équipe en sont prévenus.
 */
export async function createBudgetRequest(deps: AdminDeps, user: SessionUser, input: BudgetRaiseInput): Promise<{ id: string }> {
  const data = budgetRaiseInputSchema.parse(input);
  const cle = await deps.db.accessRequest.findUnique({ where: { id: data.keyRequestId } });
  if (!cle || cle.kind !== "CLE" || cle.requesterUid !== user.uid) throw new PortalError("introuvable", "Clé introuvable.", { objet: "demande_cle" });
  const emise = cleEmise(deps, cle);
  verifierMontant(emise, data.requestedBudget);
  if (await hausseEnCours(deps.db, emise.id)) {
    throw new PortalError("demande_en_cours", "Une demande de hausse du budget de cette clé est déjà en cours.", { cas: "hausse" });
  }
  // Le renouvellement fige le budget de la clé à son dépôt : une hausse accordée entre-temps serait perdue au retrait.
  if (await renouvellementEnCours(deps.db, emise.id)) {
    throw new PortalError("demande_en_cours", "Un renouvellement de cette clé est en cours.", { cas: "renouvellement" });
  }
  const created = await deps.db.accessRequest.create({
    data: {
      kind: "BUDGET",
      requesterUid: user.uid,
      requesterEmail: user.email,
      requesterName: user.name,
      teamId: emise.teamId,
      teamAlias: emise.teamAlias,
      models: [],
      justification: data.justification,
      requestedBudget: data.requestedBudget,
      raisesBudgetOfRequestId: emise.id,
    },
  });
  await recordAudit(deps.db, {
    ...parActeur(user),
    action: "BUDGET_REQUESTED",
    targetId: created.id,
    details: { teamAlias: created.teamAlias, alias: emise.keyAlias, avant: plafond(emise), demande: data.requestedBudget },
  });
  await notifyNewBudgetRequest(
    deps,
    created,
    { alias: emise.keyAlias, budgetActuel: plafond(emise), periode: emise.budgetDuration },
    await managerEmails(deps.db, created.teamId, [created.requesterUid]),
  );
  return { id: created.id };
}

/** Le demandeur complète sa demande de hausse renvoyée pour complément ; elle repasse en SOUMISE. */
export async function completeBudgetRequest(deps: AdminDeps, user: SessionUser, id: string, input: { requestedBudget: number; justification: string }): Promise<void> {
  const data = complementSchema.parse(input);
  const request = await deps.db.accessRequest.findUnique({ where: { id } });
  if (!request || request.requesterUid !== user.uid || request.kind !== "BUDGET" || !request.raisesBudgetOfRequestId) {
    throw new PortalError("introuvable", "Demande introuvable.", { objet: "demande" });
  }
  const cle = await deps.db.accessRequest.findUniqueOrThrow({ where: { id: request.raisesBudgetOfRequestId } });
  verifierMontant(cle, data.requestedBudget);
  await transitionRequest(deps.db, request, "SOUMISE", { data: { requestedBudget: data.requestedBudget, justification: data.justification } });
  await recordAudit(deps.db, { ...parActeur(user), action: "REQUEST_COMPLETED", targetId: request.id, details: { kind: request.kind, teamAlias: request.teamAlias } });
}

/**
 * Approuve une hausse de budget, au montant demandé ou à un autre, toujours au-dessus du plafond actuel. La passerelle
 * d'abord : en cas d'échec, la demande reste en attente et rien ne change. La clé garde sa valeur, son expiration et sa
 * dépense ; son budget approuvé suit, pour que remplacement et renouvellement reprennent le nouveau plafond.
 */
export async function approveBudgetRequest(deps: AdminDeps, actor: SessionUser, id: string, input: { budget: number }): Promise<void> {
  await requireGestion(deps.db, actor);
  const { budget } = approbationSchema.parse(input);
  const request = await deps.db.accessRequest.findUnique({ where: { id } });
  if (!request || request.kind !== "BUDGET" || !request.raisesBudgetOfRequestId) throw new PortalError("introuvable", "Demande introuvable.", { objet: "demande" });
  await requireDecision(deps, actor, request, "demande");
  if (!enAttenteDeValidation(request.status)) throw new PortalError("transition_interdite", "Cette demande a déjà été traitée.", { cas: "traitee" });
  const cle = cleEmise(deps, await deps.db.accessRequest.findUniqueOrThrow({ where: { id: request.raisesBudgetOfRequestId } }));
  const avant = cle.approvedBudget.toNumber();
  verifierMontant(cle, budget);
  try {
    await deps.litellm.updateKeyBudget(cle.keyTokenId, budget);
  } catch {
    throw new PortalError("passerelle_indisponible", "La hausse du budget de la clé a échoué.");
  }
  try {
    await deps.db.$transaction(async (tx) => {
      await transitionRequest(tx, request, "APPROUVEE", { data: { approvedBudget: budget, decidedBy: actor.uid, decidedAt: deps.now?.() ?? new Date() } });
      // Une clé remplacée entre-temps a un autre jeton, créé à l'ancien plafond : la hausse ne la concerne pas.
      const { count } = await tx.accessRequest.updateMany({ where: { id: cle.id, status: "CLE_EMISE", keyTokenId: cle.keyTokenId }, data: { approvedBudget: budget } });
      if (count === 0) throw new PortalError("transition_interdite", "La clé a été modifiée entre-temps ; rechargez la page.", { cas: "modifiee" });
    });
  } catch (e) {
    // Décidée entre-temps, la demande garde le plafond de la décision qui l'a emporté ; sinon, l'ancien revient.
    const decidee = await deps.db.accessRequest.findUnique({ where: { id } }).catch(() => null);
    const retenu = decidee?.status === "APPROUVEE" ? (decidee.approvedBudget?.toNumber() ?? avant) : avant;
    await deps.litellm.updateKeyBudget(cle.keyTokenId, retenu).catch(() => undefined);
    throw e;
  }
  await recordAudit(deps.db, {
    actorUid: actor.uid,
    action: "BUDGET_RAISED",
    targetId: request.id,
    details: { alias: cle.keyAlias, avant, demande: request.requestedBudget?.toNumber() ?? null, accorde: budget },
  });
  await notifyBudgetRaised(deps, request, { alias: cle.keyAlias, budget, periode: cle.budgetDuration });
  await annoncerDecision(deps, actor, request, "budget");
}

/** Clé dont on relève le budget : encore émise, non expirée, avec un plafond et sa période. */
function cleEmise(deps: AdminDeps, cle: AccessRequest): AccessRequest & { keyTokenId: string; keyAlias: string; approvedBudget: Prisma.Decimal; budgetDuration: string } {
  const maintenant = deps.now?.() ?? new Date();
  if (cle.keyExpiresAt && cle.keyExpiresAt <= maintenant) {
    throw new PortalError("transition_interdite", "Cette clé a expiré : demandez son renouvellement.", { cas: "expiree" });
  }
  if (cle.status !== "CLE_EMISE" || !cle.keyTokenId || !cle.keyAlias) throw new PortalError("transition_interdite", "Cette clé n'est plus active.");
  if (cle.approvedBudget === null || !cle.budgetDuration) throw new PortalError("transition_interdite", "Cette clé n'a pas de budget à relever.");
  return { ...cle, keyTokenId: cle.keyTokenId, keyAlias: cle.keyAlias, approvedBudget: cle.approvedBudget, budgetDuration: cle.budgetDuration };
}

const plafond = (cle: AccessRequest) => cle.approvedBudget?.toNumber() ?? null;

/** Le nouveau plafond doit dépasser strictement celui de la clé. */
function verifierMontant(cle: AccessRequest, montant: number): void {
  const actuel = plafond(cle);
  if (actuel !== null && montant <= actuel) {
    throw new PortalError("budget_trop_bas", `Le montant doit dépasser le plafond actuel de la clé (${actuel} €).`, { plafond: `${actuel} €` });
  }
}

/** Renouvellement de la clé pas encore décidé, ou approuvé et pas encore retiré. */
async function renouvellementEnCours(db: Db, keyRequestId: string): Promise<boolean> {
  const statuts = [...STATUTS_PAS_ENCORE_DECIDES, "APPROUVEE" as const];
  return (await db.accessRequest.count({ where: { kind: "CLE", renewsRequestId: keyRequestId, status: { in: statuts } } })) > 0;
}
