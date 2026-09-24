import { z } from "zod";
import type { SessionUser } from "@/lib/auth-user";
import type { Db } from "@/lib/db";
import type { LiteLLMClient } from "@/lib/litellm/client";
import { PolicyViolationError, PortalError } from "@/lib/errors";
import type { Prisma } from "@/generated/prisma/client";
import { type CatalogModel, checkKeyRequest, checkTransition, type DataLevel, type RequestStatus } from "@/lib/policy";

interface RequestDeps {
  db: Db;
  litellm: LiteLLMClient;
}

/** F-20 / F-21 : formulaire de demande de clé. */
export const keyRequestInputSchema = z.object({
  teamId: z.string().min(1),
  dataLevel: z.enum(["N1", "N2", "N3"]),
  models: z.array(z.string().min(1)),
  justification: z.string().trim().min(1),
  project: z.string().trim().nullable(),
  requestedBudget: z.number().positive().nullable(),
  requestedDays: z.number().int().positive().nullable(),
  keyType: z.enum(["PERSONNELLE", "SERVICE"]),
  commitment: z.boolean(),
});

export type KeyRequestInput = z.infer<typeof keyRequestInputSchema>;

/** Ligne de « Mes demandes » (F-24). */
export interface RequestSummary {
  id: string;
  kind: "CLE" | "ADHESION_EQUIPE";
  teamAlias: string;
  dataLevel: DataLevel | null;
  models: string[];
  status: RequestStatus;
  decisionComment: string | null;
  createdAt: Date;
}

/** F-20 : enregistre une demande de clé au statut SOUMISE. */
export async function createKeyRequest(deps: RequestDeps, user: SessionUser, input: KeyRequestInput): Promise<{ id: string }> {
  const data = keyRequestInputSchema.parse(input);
  if (!data.commitment) {
    throw new PortalError("engagement_requis", "Engagez-vous à ne pas soumettre de données d'un niveau supérieur à celui déclaré.");
  }
  const team = await deps.litellm.getTeam(data.teamId);
  if (!team) throw new PortalError("introuvable", "Équipe introuvable.");
  const draft = { requesterUid: user.uid, teamId: team.teamId, dataLevel: data.dataLevel, models: data.models };
  const verdict = checkKeyRequest(draft, team, await loadPolicyCatalog(deps.db));
  if (!verdict.ok) throw new PolicyViolationError(verdict.checks.filter((c) => !c.ok));
  const created = await deps.db.accessRequest.create({
    data: {
      kind: "CLE",
      requesterUid: user.uid,
      requesterEmail: user.email,
      teamId: team.teamId,
      teamAlias: team.teamAlias,
      dataLevel: data.dataLevel,
      models: data.models,
      justification: data.justification,
      project: data.project,
      keyType: data.keyType,
      requestedBudget: data.requestedBudget,
      requestedDays: data.requestedDays,
    },
  });
  return { id: created.id };
}

/** F-24 : le demandeur annule sa demande. Pour un autre utilisateur, la demande n'existe pas. */
export async function cancelRequest(deps: RequestDeps, user: SessionUser, id: string): Promise<void> {
  const request = await deps.db.accessRequest.findUnique({ where: { id } });
  if (!request || request.requesterUid !== user.uid) throw new PortalError("introuvable", "Demande introuvable.");
  await transitionRequest(deps.db, request, "ANNULEE");
}

/**
 * Règle 5 : applique une transition de statut autorisée. La mise à jour est conditionnée au statut
 * lu (verrou optimiste) : une décision concurrente fait échouer la seconde au lieu de l'écraser.
 */
export async function transitionRequest(
  db: Db,
  request: { id: string; status: RequestStatus },
  to: RequestStatus,
  options: { comment?: string; data?: Prisma.AccessRequestUpdateManyMutationInput } = {},
): Promise<void> {
  const check = checkTransition(request.status, to, { comment: options.comment });
  if (!check.ok) throw new PortalError(check.reason, TRANSITION_MESSAGES[check.reason]);
  const { count } = await db.accessRequest.updateMany({ where: { id: request.id, status: request.status }, data: { ...options.data, status: to } });
  if (count === 0) throw new PortalError("transition_interdite", "La demande a été modifiée entre-temps ; rechargez la page.");
}

const TRANSITION_MESSAGES = {
  transition_interdite: "Cette action n'est pas possible au statut actuel de la demande.",
  motif_obligatoire: "Un motif est obligatoire.",
} as const;

/** Catalogue enrichi, tel que la politique le voit (niveau et visibilité de chaque modèle). */
async function loadPolicyCatalog(db: Db): Promise<CatalogModel[]> {
  const entries = await db.catalogEntry.findMany({ select: { modelName: true, dataLevel: true, visible: true } });
  return entries;
}

/** F-24 : demandes de l'utilisateur, les plus récentes d'abord. */
export async function listMyRequests(deps: RequestDeps, user: SessionUser): Promise<RequestSummary[]> {
  const rows = await deps.db.accessRequest.findMany({ where: { requesterUid: user.uid }, orderBy: { createdAt: "desc" } });
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    teamAlias: r.teamAlias,
    dataLevel: r.dataLevel,
    models: r.models,
    status: r.status,
    decisionComment: r.decisionComment,
    createdAt: r.createdAt,
  }));
}
