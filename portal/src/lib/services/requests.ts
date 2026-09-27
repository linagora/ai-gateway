import { z } from "zod";
import type { SessionUser } from "@/lib/auth-user";
import type { Db } from "@/lib/db";
import type { LiteLLMClient, LiteLLMTeamSummary } from "@/lib/litellm/client";
import { PolicyViolationError, PortalError } from "@/lib/errors";
import type { Prisma, RequestKind } from "@/generated/prisma/client";
import { type CatalogModel, checkKeyRequest, checkTransition, DATA_LEVELS, type DataLevel, type KeyRequestDraft, type PolicyVerdict, type RequestStatus } from "@/lib/policy";
import { parActeur, recordAudit } from "./audit";
import { markExpired } from "./echeances";
import { managerEmails } from "./autorite";
import { type NotificationDeps, notifyNewRequest } from "./notifications";
import { libelleOffre } from "./offers";

interface RequestDeps extends NotificationDeps {
  db: Db;
  litellm: LiteLLMClient;
  /** Date du jour, injectée par les tests ; l'heure réelle sinon. */
  now?: () => Date;
}

/** F-20 / F-21 : formulaire de demande de clé. */
export const keyRequestInputSchema = z.object({
  teamId: z.string().min(1),
  dataLevel: z.enum(DATA_LEVELS),
  models: z.array(z.string().min(1)),
  justification: z.string().trim().min(1),
  project: z.string().trim().nullable(),
  /** Budget souhaité : plus demandé au salarié ; un renouvellement reprend celui de la clé d'origine. */
  requestedBudget: z.number().positive().nullable(),
  /** Durée souhaitée, en jours ; SANS_EXPIRATION (0) : la clé n'expire jamais. */
  requestedDays: z.number().int().nonnegative().nullable(),
  commitment: z.boolean(),
  /** Renouvellement : la demande dont la clé est renouvelée (clé du demandeur, émise, expirée ou révoquée). */
  renewsRequestId: z.string().min(1).nullish(),
});

export type KeyRequestInput = z.infer<typeof keyRequestInputSchema>;

/** Ligne de « Mes demandes » (F-24). */
export interface RequestSummary {
  id: string;
  kind: RequestKind;
  /** Demande d'abonnement : l'offre demandée, « Anthropic · Claude Max 5x ». */
  offer: string | null;
  teamId: string;
  teamAlias: string;
  dataLevel: DataLevel | null;
  models: string[];
  status: RequestStatus;
  decisionComment: string | null;
  /** Renouvellement d'une clé : la demande dont vient la clé renouvelée. */
  renewsRequestId: string | null;
  createdAt: Date;
}

/** F-20 : enregistre une demande de clé au statut SOUMISE. */
export async function createKeyRequest(deps: RequestDeps, user: SessionUser, input: KeyRequestInput): Promise<{ id: string }> {
  const fields = await validateKeyRequest(deps, user, input);
  const origine = input.renewsRequestId ? await ownKeyToRenew(deps, user, input.renewsRequestId) : null;
  const created = await deps.db.accessRequest.create({
    data: { kind: "CLE", requesterUid: user.uid, requesterEmail: user.email, requesterName: user.name, ...fields, renewsRequestId: origine?.id ?? null },
  });
  await recordAudit(deps.db, {
    ...parActeur(user),
    action: origine ? "RENEWAL_REQUESTED" : "REQUEST_CREATED",
    targetId: created.id,
    details: origine ? { kind: "CLE", teamAlias: created.teamAlias, origine: origine.id } : { kind: "CLE", teamAlias: created.teamAlias },
  });
  await notifyNewRequest(deps, created, await managerEmails(deps.db, created.teamId, [created.requesterUid]));
  return { id: created.id };
}

/** Clé que le demandeur peut renouveler : la sienne, retirée un jour (émise, expirée ou révoquée). */
export async function ownKeyToRenew(deps: { db: Db }, user: SessionUser, requestId: string) {
  const origine = await deps.db.accessRequest.findUnique({ where: { id: requestId } });
  if (!origine || origine.kind !== "CLE" || origine.requesterUid !== user.uid || !origine.keyIssuedAt || !origine.dataLevel) {
    throw new PortalError("introuvable", "Clé introuvable.", { objet: "demande_cle" });
  }
  return origine;
}

/** F-24 : le demandeur complète une demande renvoyée par l'admin ; elle repasse en SOUMISE. */
export async function completeRequest(deps: RequestDeps, user: SessionUser, id: string, input: KeyRequestInput): Promise<void> {
  const request = await deps.db.accessRequest.findUnique({ where: { id } });
  if (!request || request.requesterUid !== user.uid || request.kind !== "CLE") throw new PortalError("introuvable", "Demande introuvable.", { objet: "demande" });
  const fields = await validateKeyRequest(deps, user, input);
  await transitionRequest(deps.db, request, "SOUMISE", { data: fields });
  await recordAudit(deps.db, { ...parActeur(user), action: "REQUEST_COMPLETED", targetId: request.id, details: { kind: request.kind, teamAlias: fields.teamAlias } });
}

/** F-20, F-21, règle 3 : saisie validée, engagement coché, équipe existante, contrôles de politique passés. */
async function validateKeyRequest(deps: RequestDeps, user: SessionUser, input: KeyRequestInput) {
  const data = keyRequestInputSchema.parse(input);
  if (!data.commitment) {
    throw new PortalError("engagement_requis", "Engagez-vous à ne pas soumettre de données d'un niveau supérieur à celui déclaré.");
  }
  const team = await deps.litellm.getTeam(data.teamId);
  if (!team) throw new PortalError("introuvable", "Équipe introuvable.", { objet: "equipe" });
  const verdict = await evaluateKeyRequest(deps, { requesterUid: user.uid, teamId: team.teamId, dataLevel: data.dataLevel, models: data.models });
  if (!verdict.ok) throw new PolicyViolationError(verdict.checks.filter((c) => !c.ok));
  return {
    teamId: team.teamId,
    teamAlias: team.teamAlias,
    dataLevel: data.dataLevel,
    models: data.models,
    justification: data.justification,
    project: data.project,
    requestedBudget: data.requestedBudget,
    requestedDays: data.requestedDays,
  };
}

export const teamJoinInputSchema = z.object({
  teamId: z.string().min(1),
  justification: z.string().trim().min(1),
});

export type TeamJoinInput = z.infer<typeof teamJoinInputSchema>;

/** F-22 : demande d'ajout à une équipe existante, validée par un admin. */
export async function createTeamJoinRequest(deps: RequestDeps, user: SessionUser, input: TeamJoinInput): Promise<{ id: string }> {
  const data = teamJoinInputSchema.parse(input);
  const team = await deps.litellm.getTeam(data.teamId);
  if (!team) throw new PortalError("introuvable", "Équipe introuvable.", { objet: "equipe" });
  if (team.memberUids.includes(user.uid)) throw new PortalError("deja_membre", `Vous êtes déjà membre de l'équipe ${team.teamAlias}.`, { equipe: team.teamAlias });
  if ((await demandesDAccesEnCours(deps.db, user, team.teamId)).length > 0) {
    throw new PortalError("demande_en_cours", `Vous avez déjà une demande d'accès en cours pour l'équipe ${team.teamAlias}.`, { equipe: team.teamAlias });
  }
  const created = await deps.db.accessRequest.create({
    data: {
      kind: "ADHESION_EQUIPE",
      requesterUid: user.uid,
      requesterEmail: user.email,
      requesterName: user.name,
      teamId: team.teamId,
      teamAlias: team.teamAlias,
      models: [],
      justification: data.justification,
    },
  });
  await recordAudit(deps.db, { ...parActeur(user), action: "REQUEST_CREATED", targetId: created.id, details: { kind: "ADHESION_EQUIPE", teamAlias: team.teamAlias } });
  await notifyNewRequest(deps, created, await managerEmails(deps.db, created.teamId, [created.requesterUid]));
  return { id: created.id };
}

/**
 * F-24 : le demandeur annule sa demande soumise ou à compléter. Une demande approuvée ne s'annule qu'à la sortie de son
 * équipe (F-54). Pour un autre utilisateur, la demande n'existe pas.
 */
export async function cancelRequest(deps: RequestDeps, user: SessionUser, id: string): Promise<void> {
  const request = await deps.db.accessRequest.findUnique({ where: { id } });
  if (!request || request.requesterUid !== user.uid) throw new PortalError("introuvable", "Demande introuvable.", { objet: "demande" });
  if (request.status === "APPROUVEE") throw new PortalError("transition_interdite", "Cette demande a déjà été traitée.", { cas: "traitee" });
  await transitionRequest(deps.db, request, "ANNULEE");
  await recordAudit(deps.db, { ...parActeur(user), action: "REQUEST_CANCELLED", targetId: request.id, details: { kind: request.kind, teamAlias: request.teamAlias } });
}

/**
 * Demandes en cours dans une équipe (F-54, #38) : soumises ou à compléter, demandes de clé approuvées dont la clé
 * n'est pas retirée, et demandes d'abonnement approuvées pas encore déclarées. Une demande d'accès approuvée est close :
 * le salarié est entré dans l'équipe.
 */
export const DEMANDES_EN_COURS: Prisma.AccessRequestWhereInput = {
  OR: [{ status: { in: ["SOUMISE", "A_COMPLETER"] } }, { kind: { in: ["CLE", "ABONNEMENT"] }, status: "APPROUVEE" }],
};

/**
 * F-54 : sortie d'une équipe. Annule les demandes en cours d'un membre dans cette équipe, pour qu'il ne puisse plus y
 * obtenir de clé ; rend leur nombre. Appelée par le service des équipes, qui contrôle l'autorité de l'acteur.
 */
export async function cancelMemberRequests(db: Db, teamId: string, uid: string): Promise<number> {
  const enCours = await db.accessRequest.findMany({ where: { teamId, requesterUid: uid, ...DEMANDES_EN_COURS } });
  for (const demande of enCours) await transitionRequest(db, demande, "ANNULEE");
  return enCours.length;
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
  if (count === 0) throw new PortalError("transition_interdite", "La demande a été modifiée entre-temps ; rechargez la page.", { cas: "modifiee" });
}

const TRANSITION_MESSAGES = {
  transition_interdite: "Cette action n'est pas possible au statut actuel de la demande.",
  motif_obligatoire: "Un motif est obligatoire.",
} as const;

/**
 * Règles 3 et 4 : contrôles d'une demande avec l'état ACTUEL de l'équipe et du catalogue.
 * Une équipe supprimée depuis n'a plus de membres : le contrôle d'appartenance échoue.
 */
export async function evaluateKeyRequest(deps: RequestDeps, draft: KeyRequestDraft): Promise<PolicyVerdict> {
  const team = (await deps.litellm.getTeam(draft.teamId)) ?? { teamId: draft.teamId, models: [], memberUids: [] };
  const catalog: CatalogModel[] = await deps.db.catalogEntry.findMany({ select: { modelName: true, dataLevel: true, visible: true } });
  return checkKeyRequest(draft, team, catalog);
}

/** F-24 : demandes de l'utilisateur, les plus récentes d'abord. */
export async function listMyRequests(deps: RequestDeps, user: SessionUser): Promise<RequestSummary[]> {
  await markExpired(deps.db, deps.now?.() ?? new Date());
  const rows = await deps.db.accessRequest.findMany({ where: { requesterUid: user.uid }, orderBy: { createdAt: "desc" }, include: { offer: true } });
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    offer: r.offer && libelleOffre(r.offer),
    teamId: r.teamId,
    teamAlias: r.teamAlias,
    dataLevel: r.dataLevel,
    models: r.models,
    status: r.status,
    decisionComment: r.decisionComment,
    renewsRequestId: r.renewsRequestId,
    createdAt: r.createdAt,
  }));
}

/** F-20 : équipes dont l'utilisateur est membre (source de vérité : LiteLLM). */
export async function listMyTeams(deps: RequestDeps, user: SessionUser): Promise<LiteLLMTeamSummary[]> {
  return (await deps.litellm.getUser(user.uid))?.teams ?? [];
}

/**
 * Pastilles du menu du salarié : ses clés approuvées à retirer, ses abonnements approuvés à déclarer (spécification #51),
 * et ses demandes qu'un admin lui demande de compléter.
 */
export async function countMyPending(
  deps: RequestDeps,
  user: SessionUser,
): Promise<{ clesARetirer: number; abonnementsADeclarer: number; demandesACompleter: number }> {
  await markExpired(deps.db, deps.now?.() ?? new Date());
  const [clesARetirer, abonnementsADeclarer, demandesACompleter] = await Promise.all([
    deps.db.accessRequest.count({ where: { requesterUid: user.uid, kind: "CLE", status: "APPROUVEE" } }),
    deps.db.accessRequest.count({ where: { requesterUid: user.uid, kind: "ABONNEMENT", status: "APPROUVEE" } }),
    deps.db.accessRequest.count({ where: { requesterUid: user.uid, status: "A_COMPLETER" } }),
  ]);
  return { clesARetirer, abonnementsADeclarer, demandesACompleter };
}

/** F-22 : équipes existantes que l'utilisateur peut demander à rejoindre. */
export async function listJoinableTeams(deps: RequestDeps, user: SessionUser): Promise<LiteLLMTeamSummary[]> {
  const [mine, enCours] = await Promise.all([listMyTeams(deps, user), demandesDAccesEnCours(deps.db, user)]);
  const exclues = new Set([...mine.map((t) => t.teamId), ...enCours.map((r) => r.teamId)]);
  return (await deps.litellm.listTeams()).filter((t) => !exclues.has(t.teamId)).sort((a, b) => a.teamAlias.localeCompare(b.teamAlias));
}

/** Demandes d'accès du salarié encore en cours (soumises ou à compléter). */
function demandesDAccesEnCours(db: Db, user: SessionUser, teamId?: string) {
  return db.accessRequest.findMany({
    where: { requesterUid: user.uid, kind: "ADHESION_EQUIPE", status: { in: ["SOUMISE", "A_COMPLETER"] }, ...(teamId ? { teamId } : {}) },
    select: { teamId: true },
  });
}
