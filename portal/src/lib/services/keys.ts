import type { SessionUser } from "@/lib/auth-user";
import type { Db } from "@/lib/db";
import { PortalError } from "@/lib/errors";
import type { ApiKind, KeyInfo, LiteLLMClient } from "@/lib/litellm/client";
import type { DataLevel, RequestStatus } from "@/lib/policy";
import { requireAdmin } from "@/lib/rbac";
import { recordAudit } from "./audit";
import { markExpired } from "./echeances";
import { type NotificationDeps, notifyExpiryReminder, notifyPickupReminder } from "./notifications";
import { ownKeyToRenew, transitionRequest } from "./requests";
import { readSettings } from "./settings";

/** Dépendances du service des clés ; la date du jour est injectée pour rendre les échéances testables. */
export interface KeyDeps extends NotificationDeps {
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
  await markExpired(deps.db, deps.now?.() ?? new Date());
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
  await markExpired(deps.db, deps.now?.() ?? new Date());
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
  // Renouvellement : la clé d'origine encore émise est supprimée ; sinon, la nouvelle est retirée et rien ne change.
  const origine = request.renewsRequestId ? await deps.db.accessRequest.findUnique({ where: { id: request.renewsRequestId } }) : null;
  const origineActive = origine?.status === "CLE_EMISE" && origine.keyTokenId ? origine : null;
  if (origineActive?.keyTokenId) {
    try {
      await deleteFromGateway(deps.litellm, origineActive.keyTokenId);
    } catch (e) {
      await deps.litellm.deleteKey(generee.tokenId).catch(() => undefined);
      throw e;
    }
  }
  await transitionRequest(deps.db, request, "CLE_EMISE", {
    data: { keyAlias: generee.alias, keyTokenId: generee.tokenId, keyIssuedAt: maintenant, keyExpiresAt: generee.expiresAt },
  });
  await recordAudit(deps.db, { actorUid: user.uid, action: "KEY_GENERATED", targetId: request.id, details: { alias: generee.alias } });
  if (origineActive) {
    await transitionRequest(deps.db, origineActive, "REVOQUEE");
    await recordAudit(deps.db, {
      actorUid: user.uid,
      action: "KEY_REVOKED",
      targetId: origineActive.id,
      details: { alias: origineActive.keyAlias, raison: "renouvellement" },
    });
  }
  return { key: generee.key, alias: generee.alias };
}

/** F-44 : brouillon de la demande de renouvellement d'une clé, prérempli avec ses paramètres. */
export async function renewalDraft(deps: KeyDeps, user: SessionUser, requestId: string) {
  const origine = await ownKeyToRenew(deps, user, requestId);
  return {
    teamId: origine.teamId,
    dataLevel: origine.dataLevel as DataLevel,
    models: origine.approvedModels,
    project: origine.project,
    requestedBudget: origine.approvedBudget?.toNumber() ?? null,
    requestedDays: origine.approvedDays,
    keyType: origine.keyType ?? "PERSONNELLE",
    alias: origine.keyAlias as string,
  };
}

/** Clé émise vue par les admins (« Gestion — Clés ») : avec son titulaire. */
export interface AdminKey extends Omit<IssuedKey, "example"> {
  holderUid: string;
  holderEmail: string;
}

/** F-43 : toutes les clés émises, les actives d'abord puis les plus récentes, avec leur dépense lue en direct. */
export async function listAllKeys(deps: KeyDeps, actor: SessionUser): Promise<AdminKey[]> {
  requireAdmin(actor);
  await markExpired(deps.db, deps.now?.() ?? new Date());
  const rows = await deps.db.accessRequest.findMany({
    where: { kind: "CLE", keyAlias: { not: null }, keyIssuedAt: { not: null } },
    orderBy: { keyIssuedAt: "desc" },
  });
  const usages = await Promise.all(rows.map((r) => (r.status === "CLE_EMISE" && r.keyTokenId ? keyUsage(deps.litellm, r.keyTokenId) : null)));
  return rows
    .map((r, i) => ({
      requestId: r.id,
      holderUid: r.requesterUid,
      holderEmail: r.requesterEmail,
      alias: r.keyAlias as string,
      teamAlias: r.teamAlias,
      dataLevel: r.dataLevel as DataLevel,
      models: r.approvedModels,
      project: r.project,
      issuedAt: r.keyIssuedAt as Date,
      expiresAt: r.keyExpiresAt,
      status: r.status,
      usage: usages[i],
    }))
    .sort((a, b) => Number(b.status === "CLE_EMISE") - Number(a.status === "CLE_EMISE"));
}

/**
 * F-43 : révocation d'une clé, par son titulaire ou par un admin : suppression dans LiteLLM, demande
 * « Révoquée » (statut final). Le journal d'audit nomme l'auteur.
 */
export async function revokeKey(deps: KeyDeps, user: SessionUser, requestId: string): Promise<void> {
  const request = await deps.db.accessRequest.findUnique({ where: { id: requestId } });
  if (!request || request.kind !== "CLE" || (request.requesterUid !== user.uid && !user.isAdmin) || !request.keyTokenId) {
    throw new PortalError("introuvable", "Clé introuvable.", { objet: "demande_cle" });
  }
  if (request.status !== "CLE_EMISE") throw new PortalError("transition_interdite", "Cette clé n'est plus active.", { cas: "traitee" });
  await deleteFromGateway(deps.litellm, request.keyTokenId);
  await transitionRequest(deps.db, request, "REVOQUEE");
  await recordAudit(deps.db, { actorUid: user.uid, action: "KEY_REVOKED", targetId: request.id, details: { alias: request.keyAlias } });
}

/**
 * F-41 : remplacement d'une clé perdue. La nouvelle clé reprend les paramètres de l'ancienne et expire à la
 * même date ; son alias porte le rang du remplacement (-2, -3…). L'ancienne est supprimée ; si elle ne peut
 * pas l'être, la nouvelle est retirée aussitôt et rien ne change : une clé perdue ne reste jamais active
 * à côté de sa remplaçante.
 */
export async function replaceKey(deps: KeyDeps, user: SessionUser, requestId: string): Promise<{ key: string; alias: string }> {
  const request = await deps.db.accessRequest.findUnique({ where: { id: requestId } });
  if (!request || request.kind !== "CLE" || request.requesterUid !== user.uid || !request.keyTokenId || !request.dataLevel) {
    throw new PortalError("introuvable", "Clé introuvable.", { objet: "demande_cle" });
  }
  if (request.status !== "CLE_EMISE") throw new PortalError("transition_interdite", "Cette clé n'est plus active.", { cas: "traitee" });
  const maintenant = deps.now?.() ?? new Date();
  if (!request.keyExpiresAt || request.keyExpiresAt <= maintenant) {
    throw new PortalError("transition_interdite", "Cette clé a expiré : demandez son renouvellement.", { cas: "expiree" });
  }
  if (request.approvedBudget === null || !request.budgetDuration) throw new PortalError("parametre_manquant", "Paramètres de la clé incomplets.");
  // Une clé bloquée par un admin ne se remplace pas : le blocage serait contourné.
  const etat = await deps.litellm.getKeyInfo(request.keyTokenId).catch(() => {
    throw new PortalError("passerelle_indisponible", "L'état de la clé n'a pas pu être vérifié.");
  });
  if (etat?.blocked) throw new PortalError("transition_interdite", "Cette clé est bloquée par un administrateur.", { cas: "bloquee" });
  const rang = request.keyReplacements + 2;
  let nouvelle;
  try {
    nouvelle = await deps.litellm.generateKey({
      userId: request.requesterUid,
      teamId: request.teamId,
      models: request.approvedModels,
      maxBudget: request.approvedBudget.toNumber(),
      budgetDuration: request.budgetDuration,
      // Durée restante, à la seconde : la nouvelle clé expire à la même date que l'ancienne.
      duration: `${Math.ceil((request.keyExpiresAt.getTime() - maintenant.getTime()) / 1000)}s`,
      rpmLimit: request.rpmLimit,
      tpmLimit: request.tpmLimit,
      alias: `${keyAlias(request)}-${rang}`,
      metadata: {
        request_id: request.id,
        project: request.project,
        data_level: request.dataLevel,
        approved_by: request.decidedBy,
        key_type: request.keyType,
      },
    });
  } catch {
    throw new PortalError("passerelle_indisponible", "La génération de la clé de remplacement a échoué.");
  }
  const retirerLaNouvelle = () => deps.litellm.deleteKey(nouvelle.tokenId).catch(() => undefined);
  try {
    await deleteFromGateway(deps.litellm, request.keyTokenId);
  } catch (e) {
    await retirerLaNouvelle();
    throw e;
  }
  const { count } = await deps.db.accessRequest.updateMany({
    where: { id: request.id, status: "CLE_EMISE", keyTokenId: request.keyTokenId },
    data: { keyTokenId: nouvelle.tokenId, keyAlias: nouvelle.alias, keyIssuedAt: maintenant, keyExpiresAt: nouvelle.expiresAt, keyReplacements: { increment: 1 } },
  });
  if (count === 0) {
    await retirerLaNouvelle();
    throw new PortalError("transition_interdite", "La clé a été modifiée entre-temps ; rechargez la page.", { cas: "modifiee" });
  }
  await recordAudit(deps.db, { actorUid: user.uid, action: "KEY_REPLACED", targetId: request.id, details: { alias: nouvelle.alias, ancienAlias: request.keyAlias } });
  return { key: nouvelle.key, alias: nouvelle.alias };
}

/** F-43 : blocage d'une clé par un admin (suspension temporaire et réversible) ; la demande reste « Clé émise ». */
export async function blockKey(deps: KeyDeps, actor: SessionUser, requestId: string): Promise<void> {
  await changeBlocking(deps, actor, requestId, true);
}

/** F-43 : déblocage d'une clé bloquée par un admin. */
export async function unblockKey(deps: KeyDeps, actor: SessionUser, requestId: string): Promise<void> {
  await changeBlocking(deps, actor, requestId, false);
}

async function changeBlocking(deps: KeyDeps, actor: SessionUser, requestId: string, bloquer: boolean): Promise<void> {
  requireAdmin(actor);
  const request = await deps.db.accessRequest.findUnique({ where: { id: requestId } });
  if (!request || request.kind !== "CLE" || !request.keyTokenId) throw new PortalError("introuvable", "Clé introuvable.", { objet: "demande_cle" });
  if (request.status !== "CLE_EMISE") throw new PortalError("transition_interdite", "Cette clé n'est plus active.", { cas: "traitee" });
  try {
    await (bloquer ? deps.litellm.blockKey(request.keyTokenId) : deps.litellm.unblockKey(request.keyTokenId));
  } catch {
    throw new PortalError("passerelle_indisponible", bloquer ? "Le blocage de la clé a échoué." : "Le déblocage de la clé a échoué.");
  }
  await recordAudit(deps.db, { actorUid: actor.uid, action: bloquer ? "KEY_BLOCKED" : "KEY_UNBLOCKED", targetId: request.id, details: { alias: request.keyAlias } });
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

/** Compte rendu de la tâche quotidienne. */
export interface DailyTaskReport {
  rappelsRetrait: number;
  rappelsExpiration: number;
  demandesExpirees: number;
  clesExpirees: number;
}

/**
 * F-45 : tâche quotidienne. Elle fait expirer ce qui est échu, puis envoie une seule fois chacun les rappels :
 * trois jours avant l'échéance de retrait, sept jours avant l'expiration d'une clé.
 */
export async function runDailyTask(deps: KeyDeps): Promise<DailyTaskReport> {
  const maintenant = deps.now?.() ?? new Date();
  const expirations = await markExpired(deps.db, maintenant);
  const delai = (await readSettings(deps.db)).pickup_days;
  let rappelsRetrait = 0;
  let rappelsExpiration = 0;
  if (delai) {
    const debut = new Date(maintenant.getTime() - Number(delai) * JOUR);
    const aRetirer = await deps.db.accessRequest.findMany({
      where: { kind: "CLE", status: "APPROUVEE", pickupReminderSentAt: null, decidedAt: { gt: debut, lte: new Date(debut.getTime() + 3 * JOUR) } },
    });
    for (const r of aRetirer) {
      const { count } = await deps.db.accessRequest.updateMany({ where: { id: r.id, pickupReminderSentAt: null }, data: { pickupReminderSentAt: maintenant } });
      if (count === 0 || !r.decidedAt) continue;
      rappelsRetrait++;
      await notifyPickupReminder(deps, { to: r.requesterEmail, equipe: r.teamAlias, echeance: new Date(r.decidedAt.getTime() + Number(delai) * JOUR) });
    }
  }
  const aExpirer = await deps.db.accessRequest.findMany({
    where: { kind: "CLE", status: "CLE_EMISE", expiryReminderSentAt: null, keyExpiresAt: { gt: maintenant, lte: new Date(maintenant.getTime() + 7 * JOUR) } },
  });
  for (const r of aExpirer) {
    const { count } = await deps.db.accessRequest.updateMany({ where: { id: r.id, expiryReminderSentAt: null }, data: { expiryReminderSentAt: maintenant } });
    if (count === 0 || !r.keyExpiresAt || !r.keyAlias) continue;
    rappelsExpiration++;
    await notifyExpiryReminder(deps, { to: r.requesterEmail, alias: r.keyAlias, echeance: r.keyExpiresAt });
  }
  return { rappelsRetrait, rappelsExpiration, ...expirations };
}
