import { z } from "zod";
import type { SessionUser } from "@/lib/auth-user";
import type { Db } from "@/lib/db";
import { PolicyViolationError, PortalError } from "@/lib/errors";
import type { LiteLLMClient } from "@/lib/litellm/client";
import type { DataLevel, PolicyCheck, RequestStatus } from "@/lib/policy";
import { requireAdmin } from "@/lib/rbac";
import { evaluateKeyRequest, transitionRequest } from "./requests";
import { readSettings, type SettingValues } from "./settings";

interface AdminDeps {
  db: Db;
  litellm: LiteLLMClient;
  /** Date du jour, injectée par les tests ; l'heure réelle sinon. */
  now?: () => Date;
}

/** Ligne de la file de validation (F-30). */
export interface PendingRequest {
  id: string;
  kind: "CLE" | "ADHESION_EQUIPE";
  requesterUid: string;
  teamAlias: string;
  dataLevel: DataLevel | null;
  models: string[];
  project: string | null;
  status: RequestStatus;
  createdAt: Date;
}

/** F-30 : demandes en attente, de la plus ancienne à la plus récente. */
export async function listPendingRequests(deps: AdminDeps, actor: SessionUser): Promise<PendingRequest[]> {
  requireAdmin(actor);
  const rows = await deps.db.accessRequest.findMany({ where: { status: "SOUMISE" }, orderBy: { createdAt: "asc" } });
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    requesterUid: r.requesterUid,
    teamAlias: r.teamAlias,
    dataLevel: r.dataLevel,
    models: r.models,
    project: r.project,
    status: r.status,
    createdAt: r.createdAt,
  }));
}

/** Fiche de validation (F-32) : la demande et ses contrôles, rejoués avec l'état actuel (règle 4). */
export interface RequestReview extends PendingRequest {
  requesterEmail: string;
  teamId: string;
  justification: string;
  keyType: "PERSONNELLE" | "SERVICE" | null;
  requestedBudget: number | null;
  requestedDays: number | null;
  decidedBy: string | null;
  decisionComment: string | null;
  /** Paramètres figés à l'approbation (F-40), null tant que la demande n'est pas approuvée. */
  approved: ApprovalInput | null;
  checks: PolicyCheck[];
}

export async function getRequestReview(deps: AdminDeps, actor: SessionUser, id: string): Promise<RequestReview> {
  requireAdmin(actor);
  const r = await deps.db.accessRequest.findUnique({ where: { id } });
  if (!r) throw new PortalError("introuvable", "Demande introuvable.", { objet: "demande" });
  const checks =
    r.kind === "CLE" && r.dataLevel
      ? (await evaluateKeyRequest(deps, { requesterUid: r.requesterUid, teamId: r.teamId, dataLevel: r.dataLevel, models: r.models })).checks
      : [];
  return {
    id: r.id,
    kind: r.kind,
    requesterUid: r.requesterUid,
    requesterEmail: r.requesterEmail,
    teamId: r.teamId,
    teamAlias: r.teamAlias,
    dataLevel: r.dataLevel,
    models: r.models,
    project: r.project,
    justification: r.justification,
    keyType: r.keyType,
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
  };
}

/** Paramètres de la clé fixés par l'admin (F-31). Durées au format LiteLLM : 30d, 12h… */
export const approvalInputSchema = z.object({
  /** Équipe de la clé : celle de la demande, sauf si l'admin en choisit une autre. */
  teamId: z.string().min(1).optional(),
  models: z.array(z.string().min(1)),
  budget: z.number().positive().nullable(),
  budgetDuration: z.string().regex(/^\d+[smhd]$/).nullable(),
  days: z.number().int().positive().nullable(),
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
  requireAdmin(actor);
  const params = withDefaults(approvalInputSchema.parse(input), await readSettings(deps.db));
  if (params.budget === null || params.budgetDuration === null || params.days === null) {
    throw new PortalError(
      "parametre_manquant",
      "Budget, période du budget et durée de validité sont obligatoires : saisissez-les ou configurez des valeurs par défaut.",
    );
  }
  const request = await deps.db.accessRequest.findUnique({ where: { id } });
  if (!request || request.kind !== "CLE" || !request.dataLevel) throw new PortalError("introuvable", "Demande de clé introuvable.", { objet: "demande_cle" });
  const equipe = await teamForApproval(deps, request, params.teamId);
  const reaffectee = equipe.teamId !== request.teamId;
  const draft = { requesterUid: request.requesterUid, teamId: equipe.teamId, dataLevel: request.dataLevel, models: params.models };
  const verdict = await evaluateKeyRequest(deps, draft);
  // Dans une équipe choisie par l'admin, l'approbation vaut adhésion : l'appartenance n'y est pas exigée.
  const bloquants = verdict.checks.filter((c) => !c.ok && !(reaffectee && c.id === "membre_equipe"));
  if (bloquants.length > 0) throw new PolicyViolationError(bloquants);
  if (verdict.checks.some((c) => c.id === "membre_equipe" && !c.ok)) await deps.litellm.addTeamMember(equipe.teamId, request.requesterUid);
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
      decidedAt: deps.now?.() ?? new Date(),
    },
  });
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
  requireAdmin(actor);
  const request = await deps.db.accessRequest.findUnique({ where: { id } });
  if (!request) throw new PortalError("introuvable", "Demande introuvable.", { objet: "demande" });
  await transitionRequest(deps.db, request, "REFUSEE", {
    comment,
    data: { decidedBy: actor.uid, decidedAt: new Date(), decisionComment: comment.trim() },
  });
}

/** F-31 : renvoie la demande au demandeur pour qu'il la complète (statut A_COMPLETER). */
export async function requestCompletion(deps: AdminDeps, actor: SessionUser, id: string, comment: string): Promise<void> {
  requireAdmin(actor);
  const request = await deps.db.accessRequest.findUnique({ where: { id } });
  if (!request) throw new PortalError("introuvable", "Demande introuvable.", { objet: "demande" });
  await transitionRequest(deps.db, request, "A_COMPLETER", {
    data: { decidedBy: actor.uid, decidedAt: new Date(), decisionComment: comment.trim() || null },
  });
}

/**
 * F-22 : approuve une demande d'adhésion en ajoutant le demandeur dans LiteLLM à l'équipe demandée, ou à
 * celle que choisit l'admin (réaffectation). LiteLLM d'abord : en cas d'échec, la demande reste SOUMISE.
 */
export async function approveTeamJoinRequest(deps: AdminDeps, actor: SessionUser, id: string, teamId?: string): Promise<void> {
  requireAdmin(actor);
  const request = await deps.db.accessRequest.findUnique({ where: { id } });
  if (!request || request.kind !== "ADHESION_EQUIPE") throw new PortalError("introuvable", "Demande d'adhésion introuvable.", { objet: "demande_adhesion" });
  if (request.status !== "SOUMISE") throw new PortalError("transition_interdite", "Cette demande a déjà été traitée.", { cas: "traitee" });
  const equipe = await teamForApproval(deps, request, teamId);
  await deps.litellm.addTeamMember(equipe.teamId, request.requesterUid);
  await transitionRequest(deps.db, request, "APPROUVEE", { data: { ...equipe, decidedBy: actor.uid, decidedAt: new Date() } });
}

/** Équipe retenue à l'approbation : celle de la demande, sauf si l'admin en choisit une autre, qui doit exister. */
async function teamForApproval(
  deps: AdminDeps,
  request: { teamId: string; teamAlias: string },
  teamId: string | undefined,
): Promise<{ teamId: string; teamAlias: string }> {
  if (!teamId || teamId === request.teamId) return { teamId: request.teamId, teamAlias: request.teamAlias };
  const team = await deps.litellm.getTeam(teamId);
  if (!team) throw new PortalError("introuvable", `Équipe introuvable : ${teamId}.`, { objet: "equipe" });
  return { teamId: team.teamId, teamAlias: team.teamAlias };
}
