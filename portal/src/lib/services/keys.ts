import type { SessionUser } from "@/lib/auth-user";
import type { Db } from "@/lib/db";
import { PortalError } from "@/lib/errors";
import type { ApiKind, KeyInfo, LiteLLMClient } from "@/lib/litellm/client";
import type { DataLevel, RequestStatus } from "@/lib/policy";
import { recordAudit } from "./audit";
import { transitionRequest } from "./requests";
import { readSettings } from "./settings";

/** Dépendances du service des clés ; la date du jour est injectée pour rendre les échéances testables. */
export interface KeyDeps {
  db: Db;
  litellm: LiteLLMClient;
  now?: () => Date;
}

const JOUR = 86_400_000;

/** Demande approuvée, en attente de retrait par son titulaire. */
export interface KeyToPickUp {
  requestId: string;
  teamAlias: string;
  dataLevel: DataLevel;
  models: string[];
  project: string | null;
  /** Échéance de retrait : approbation + délai de retrait configuré ; null si aucun délai n'est configuré. */
  pickupDeadline: Date | null;
}

/** Clé émise, telle que le portail la connaît : jamais la clé elle-même. */
export interface IssuedKey {
  requestId: string;
  alias: string;
  teamAlias: string;
  dataLevel: DataLevel;
  models: string[];
  project: string | null;
  issuedAt: Date;
  expiresAt: Date | null;
  status: RequestStatus;
  /** Dépense, budget, remise à zéro et blocage, lus en direct dans la passerelle ; null s'ils sont indisponibles. */
  usage: Omit<KeyInfo, "expiresAt"> | null;
  /** Modèle et type d'API de l'exemple d'appel (premier modèle de la clé). */
  example: { model: string; apiKind: ApiKind } | null;
}

export interface MyKeys {
  toPickUp: KeyToPickUp[];
  keys: IssuedKey[];
}

/** « Mes clés » : les demandes approuvées à retirer, puis les clés émises, du titulaire seulement. */
export async function listMyKeys(deps: KeyDeps, user: SessionUser): Promise<MyKeys> {
  const [rows, settings] = await Promise.all([
    deps.db.accessRequest.findMany({ where: { requesterUid: user.uid, kind: "CLE" }, orderBy: { createdAt: "asc" } }),
    readSettings(deps.db),
  ]);
  const delai = settings.pickup_days ? Number(settings.pickup_days) : null;
  const emises = rows.filter((r) => r.keyAlias && r.keyIssuedAt && r.dataLevel);
  // Lectures en direct dans la passerelle : une passerelle injoignable n'empêche pas d'afficher les clés.
  const [usages, typesApi] = await Promise.all([
    Promise.all(emises.map((r) => (r.status === "CLE_EMISE" && r.keyTokenId ? keyUsage(deps.litellm, r.keyTokenId) : null))),
    deps.litellm.listModels().then(
      (models) => new Map(models.map((m) => [m.modelName, m.apiKind])),
      () => new Map<string, ApiKind>(),
    ),
  ]);
  return {
    toPickUp: rows
      .filter((r) => r.status === "APPROUVEE" && r.dataLevel)
      .map((r) => ({
        requestId: r.id,
        teamAlias: r.teamAlias,
        dataLevel: r.dataLevel as DataLevel,
        models: r.approvedModels,
        project: r.project,
        pickupDeadline: delai !== null && r.decidedAt ? new Date(r.decidedAt.getTime() + delai * JOUR) : null,
      })),
    keys: emises.map((r, i) => ({
      requestId: r.id,
      alias: r.keyAlias as string,
      teamAlias: r.teamAlias,
      dataLevel: r.dataLevel as DataLevel,
      models: r.approvedModels,
      project: r.project,
      issuedAt: r.keyIssuedAt as Date,
      expiresAt: r.keyExpiresAt,
      status: r.status,
      usage: usages[i],
      example: r.approvedModels[0] ? { model: r.approvedModels[0], apiKind: typesApi.get(r.approvedModels[0]) ?? "conversation" } : null,
    })),
  };
}

/** Dépense, budget, remise à zéro et blocage d'une clé ; null si la passerelle ne répond pas ou ne la connaît pas. */
async function keyUsage(litellm: LiteLLMClient, tokenId: string): Promise<IssuedKey["usage"]> {
  try {
    const info = await litellm.getKeyInfo(tokenId);
    return info ? { spend: info.spend, maxBudget: info.maxBudget, budgetResetAt: info.budgetResetAt, blocked: info.blocked } : null;
  } catch {
    return null;
  }
}

/**
 * F-40 / F-41 : retrait d'une clé par son titulaire. La clé est générée avec les paramètres figés à
 * l'approbation, sa validité court à partir du retrait, et elle n'est rendue qu'une fois : le portail
 * n'en garde que l'empreinte, l'alias et les dates. L'unicité des alias dans LiteLLM empêche un double retrait.
 */
export async function pickUpKey(deps: KeyDeps, user: SessionUser, requestId: string): Promise<{ key: string; alias: string }> {
  const request = await deps.db.accessRequest.findUnique({ where: { id: requestId } });
  if (!request || request.kind !== "CLE" || request.requesterUid !== user.uid || !request.dataLevel) {
    throw new PortalError("introuvable", "Demande de clé introuvable.", { objet: "demande_cle" });
  }
  if (request.status !== "APPROUVEE") throw new PortalError("transition_interdite", "Cette demande n'a pas de clé à retirer.", { cas: "traitee" });
  if (request.approvedBudget === null || !request.budgetDuration || !request.approvedDays) {
    throw new PortalError("parametre_manquant", "Paramètres de la clé incomplets.");
  }
  const maintenant = deps.now?.() ?? new Date();
  const alias = keyAlias(request);
  let generee;
  try {
    generee = await deps.litellm.generateKey({
      userId: request.requesterUid,
      teamId: request.teamId,
      models: request.approvedModels,
      maxBudget: request.approvedBudget.toNumber(),
      budgetDuration: request.budgetDuration,
      duration: `${request.approvedDays}d`,
      rpmLimit: request.rpmLimit,
      tpmLimit: request.tpmLimit,
      alias,
      metadata: {
        request_id: request.id,
        project: request.project,
        data_level: request.dataLevel,
        approved_by: request.decidedBy,
        key_type: request.keyType,
      },
    });
  } catch {
    // Le détail de l'erreur ne quitte pas le serveur : il pourrait décrire la requête envoyée.
    throw new PortalError("passerelle_indisponible", "La génération de la clé a échoué.");
  }
  await transitionRequest(deps.db, request, "CLE_EMISE", {
    data: { keyAlias: generee.alias, keyTokenId: generee.tokenId, keyIssuedAt: maintenant, keyExpiresAt: generee.expiresAt },
  });
  await recordAudit(deps.db, { actorUid: user.uid, action: "KEY_GENERATED", targetId: request.id, details: { alias: generee.alias } });
  return { key: generee.key, alias: generee.alias };
}

/** F-43 : révocation d'une clé par son titulaire : suppression dans LiteLLM, demande « Révoquée » (statut final). */
export async function revokeKey(deps: KeyDeps, user: SessionUser, requestId: string): Promise<void> {
  const request = await deps.db.accessRequest.findUnique({ where: { id: requestId } });
  if (!request || request.kind !== "CLE" || request.requesterUid !== user.uid || !request.keyTokenId) {
    throw new PortalError("introuvable", "Clé introuvable.", { objet: "demande_cle" });
  }
  if (request.status !== "CLE_EMISE") throw new PortalError("transition_interdite", "Cette clé n'est plus active.", { cas: "traitee" });
  await deleteFromGateway(deps.litellm, request.keyTokenId);
  await transitionRequest(deps.db, request, "REVOQUEE");
  await recordAudit(deps.db, { actorUid: user.uid, action: "KEY_REVOKED", targetId: request.id, details: { alias: request.keyAlias } });
}

/** Supprime une clé de la passerelle ; une clé qu'elle ne connaît déjà plus (supprimée depuis la console) est acquise. */
async function deleteFromGateway(litellm: LiteLLMClient, tokenId: string): Promise<void> {
  try {
    await litellm.deleteKey(tokenId);
  } catch {
    const encoreConnue = await litellm.getKeyInfo(tokenId).then(
      (info) => info !== null,
      () => true,
    );
    if (encoreConnue) throw new PortalError("passerelle_indisponible", "La suppression de la clé a échoué.");
  }
}

/** Alias unique et lisible : <uid>-<équipe>-<projet ou « cle »>-<4 derniers caractères de la demande>. */
function keyAlias(request: { requesterUid: string; teamAlias: string; project: string | null; id: string }): string {
  return [request.requesterUid, request.teamAlias, request.project || "cle", request.id.slice(-4)].map(slug).join("-");
}

/** Minuscules, sans accents ni caractères autres que lettres et chiffres (séparés par des tirets). */
function slug(texte: string): string {
  return texte
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}
