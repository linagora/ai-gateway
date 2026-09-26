import type { SessionUser } from "@/lib/auth-user";
import type { Db } from "@/lib/db";
import { PortalError } from "@/lib/errors";
import type { AccessRequest } from "@/generated/prisma/client";
import type { ApiKind, KeyInfo, KeyParams, LiteLLMClient } from "@/lib/litellm/client";
import { SANS_EXPIRATION } from "@/lib/durees";
import type { DataLevel, RequestStatus } from "@/lib/policy";
import type { LimiteDeDebit } from "@/lib/limite-de-debit";
import { requireAdmin } from "@/lib/rbac";
import { recordAudit } from "./audit";
import { markExpired, pickupDeadline, readPickupDays } from "./echeances";
import { type NotificationDeps, notifyAdminKeyAction } from "./notifications";
import { ownKeyToRenew, transitionRequest } from "./requests";

/** Dépendances du service des clés ; la date du jour est injectée pour rendre les échéances testables. */
export interface KeyDeps extends NotificationDeps {
  db: Db;
  litellm: LiteLLMClient;
  now?: () => Date;
  /** Limite de fréquence des retraits et remplacements, par titulaire ; aucune limite si absente. */
  limiteGenerations?: LimiteDeDebit;
}

/** Le retrait et le remplacement sont limités en fréquence par titulaire (spécification #14). */
function verifierFrequence(deps: KeyDeps, user: SessionUser, maintenant: Date): void {
  if (deps.limiteGenerations && !deps.limiteGenerations.autoriser(user.uid, maintenant)) {
    throw new PortalError("trop_de_generations", "Trop de clés générées en peu de temps.");
  }
}

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
  gatewayState: Omit<KeyInfo, "expiresAt"> | null;
  /** Exemples d'appel : un par type d'API que porte la clé, avec le premier de ses modèles de ce type. */
  examples: { model: string; apiKind: ApiKind }[];
}

export interface MyKeys {
  toPickUp: KeyToPickUp[];
  keys: IssuedKey[];
}

/**
 * « Mes clés » : les demandes approuvées à retirer, puis les clés émises du titulaire seulement, les actives d'abord
 * et les plus récentes en premier ; les clés révoquées ou expirées viennent ensuite.
 */
export async function listMyKeys(deps: KeyDeps, user: SessionUser): Promise<MyKeys> {
  await markExpired(deps.db, deps.now?.() ?? new Date());
  const [rows, delai] = await Promise.all([
    deps.db.accessRequest.findMany({ where: { requesterUid: user.uid, kind: "CLE" }, orderBy: { createdAt: "asc" } }),
    readPickupDays(deps.db),
  ]);
  // Lectures en direct dans la passerelle : une passerelle injoignable n'empêche pas d'afficher les clés.
  const [emises, typesApi] = await Promise.all([
    Promise.all(rows.filter((r) => r.keyAlias && r.keyIssuedAt && r.dataLevel).map((r) => toIssuedKey(deps.litellm, r))),
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
        pickupDeadline: delai !== null && r.decidedAt ? pickupDeadline(r.decidedAt, delai) : null,
      })),
    keys: emises
      .map((k) => ({ ...k, examples: callExamples(k.models, typesApi) }))
      .sort((a, b) => Number(b.status === "CLE_EMISE") - Number(a.status === "CLE_EMISE") || b.issuedAt.getTime() - a.issuedAt.getTime()),
  };
}

/** Clé émise telle que la présentent « Mes clés » et « Gestion — Clés », avec son état lu dans la passerelle. */
async function toIssuedKey(litellm: LiteLLMClient, r: AccessRequest): Promise<Omit<IssuedKey, "examples">> {
  return {
    requestId: r.id,
    alias: r.keyAlias as string,
    teamAlias: r.teamAlias,
    dataLevel: r.dataLevel as DataLevel,
    models: r.approvedModels,
    project: r.project,
    issuedAt: r.keyIssuedAt as Date,
    expiresAt: r.keyExpiresAt,
    status: r.status,
    gatewayState: r.status === "CLE_EMISE" && r.keyTokenId ? await gatewayState(litellm, r.keyTokenId) : null,
  };
}

/** Dépense, budget, remise à zéro et blocage d'une clé ; null si la passerelle ne répond pas ou ne la connaît pas. */
async function gatewayState(litellm: LiteLLMClient, tokenId: string): Promise<IssuedKey["gatewayState"]> {
  try {
    const info = await litellm.getKeyInfo(tokenId);
    return info ? { spend: info.spend, maxBudget: info.maxBudget, budgetResetAt: info.budgetResetAt, blocked: info.blocked } : null;
  } catch {
    return null;
  }
}

/** Un exemple par type d'API, avec le premier modèle de la clé de ce type ; un modèle inconnu vaut conversation. */
function callExamples(models: string[], typesApi: Map<string, ApiKind>): IssuedKey["examples"] {
  const parType = new Map<ApiKind, string>();
  for (const model of models) {
    const apiKind = typesApi.get(model) ?? "conversation";
    if (!parType.has(apiKind)) parType.set(apiKind, model);
  }
  return [...parType].map(([apiKind, model]) => ({ model, apiKind }));
}

/**
 * F-40 / F-41 : retrait d'une clé par son titulaire. La clé est générée avec les paramètres figés à
 * l'approbation, sa validité court à partir du retrait, et elle n'est rendue qu'une fois : le portail
 * n'en garde que l'empreinte, l'alias et les dates. La demande est verrouillée avant la génération (brief,
 * règle 6) : un second retrait simultané échoue, et un échec rend la demande à retirer.
 */
export async function pickUpKey(deps: KeyDeps, user: SessionUser, requestId: string): Promise<{ key: string; alias: string }> {
  const maintenant = deps.now?.() ?? new Date();
  await markExpired(deps.db, maintenant);
  const request = await deps.db.accessRequest.findUnique({ where: { id: requestId } });
  if (!request || request.kind !== "CLE" || request.requesterUid !== user.uid || !request.dataLevel) {
    throw new PortalError("introuvable", "Demande de clé introuvable.", { objet: "demande_cle" });
  }
  if (request.status !== "APPROUVEE") throw new PortalError("transition_interdite", "Cette demande n'a pas de clé à retirer.", { cas: "traitee" });
  if (request.approvedDays === null) throw new PortalError("parametre_manquant", "Paramètres de la clé incomplets.");
  verifierFrequence(deps, user, maintenant);
  const { count } = await deps.db.accessRequest.updateMany({ where: { id: request.id, status: "APPROUVEE" }, data: { status: "CLE_EMISE", keyIssuedAt: maintenant } });
  if (count === 0) throw new PortalError("transition_interdite", "La demande a été modifiée entre-temps ; rechargez la page.", { cas: "modifiee" });
  const rendreARetirer = () =>
    deps.db.accessRequest.updateMany({ where: { id: request.id, status: "CLE_EMISE", keyTokenId: null }, data: { status: "APPROUVEE", keyIssuedAt: null } });

  let generee;
  try {
    const duree = request.approvedDays === SANS_EXPIRATION ? null : `${request.approvedDays}d`;
    generee = await deps.litellm.generateKey(keyParams(request, keyAlias(request), duree));
  } catch (e) {
    await rendreARetirer();
    // Le détail de l'erreur ne quitte pas le serveur : il pourrait décrire la requête envoyée.
    throw e instanceof PortalError ? e : new PortalError("passerelle_indisponible", "La génération de la clé a échoué.");
  }
  // Renouvellement : la clé d'origine encore émise est supprimée ; sinon, la nouvelle est retirée et rien ne change.
  const origine = request.renewsRequestId ? await deps.db.accessRequest.findUnique({ where: { id: request.renewsRequestId } }) : null;
  const origineActive = origine?.status === "CLE_EMISE" && origine.keyTokenId ? origine : null;
  if (origineActive?.keyTokenId) {
    try {
      await deleteFromGateway(deps.litellm, origineActive.keyTokenId);
    } catch (e) {
      await deps.litellm.deleteKey(generee.tokenId).catch(() => undefined);
      await rendreARetirer();
      throw e;
    }
  }
  await deps.db.accessRequest.update({
    where: { id: request.id },
    data: { keyAlias: generee.alias, keyTokenId: generee.tokenId, keyExpiresAt: generee.expiresAt },
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

/** Paramètres LiteLLM d'une clé, figés à l'approbation de sa demande (F-40). */
function keyParams(request: AccessRequest, alias: string, duration: string | null, spend?: number): KeyParams {
  if (request.approvedBudget === null || !request.budgetDuration) throw new PortalError("parametre_manquant", "Paramètres de la clé incomplets.");
  return {
    userId: request.requesterUid,
    teamId: request.teamId,
    models: request.approvedModels,
    maxBudget: request.approvedBudget.toNumber(),
    budgetDuration: request.budgetDuration,
    duration,
    rpmLimit: request.rpmLimit,
    tpmLimit: request.tpmLimit,
    alias,
    metadata: {
      request_id: request.id,
      project: request.project,
      data_level: request.dataLevel,
      approved_by: request.decidedBy,
    },
    spend,
  };
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
    alias: origine.keyAlias as string,
  };
}

/** Clé émise vue par les admins (« Gestion — Clés ») : avec son titulaire. */
export interface AdminKey extends Omit<IssuedKey, "examples"> {
  holderUid: string;
  holderEmail: string;
}

/** Clé approuvée qui attend son retrait, vue par les admins : avec son titulaire et l'échéance de retrait. */
export interface AdminKeyToPickUp {
  requestId: string;
  holderUid: string;
  holderEmail: string;
  teamAlias: string;
  dataLevel: DataLevel;
  models: string[];
  approvedAt: Date | null;
  approvedBy: string | null;
  pickupDeadline: Date | null;
}

/** Clés approuvées que leur titulaire n'a pas encore retirées, de la plus ancienne approbation à la plus récente. */
export async function listKeysToPickUp(deps: KeyDeps, actor: SessionUser): Promise<AdminKeyToPickUp[]> {
  requireAdmin(actor);
  await markExpired(deps.db, deps.now?.() ?? new Date());
  const [rows, delai] = await Promise.all([
    deps.db.accessRequest.findMany({ where: { kind: "CLE", status: "APPROUVEE" }, orderBy: { decidedAt: "asc" } }),
    readPickupDays(deps.db),
  ]);
  return rows.map((r) => ({
    requestId: r.id,
    holderUid: r.requesterUid,
    holderEmail: r.requesterEmail,
    teamAlias: r.teamAlias,
    dataLevel: r.dataLevel as DataLevel,
    models: r.approvedModels,
    approvedAt: r.decidedAt,
    approvedBy: r.decidedBy,
    pickupDeadline: delai !== null && r.decidedAt ? pickupDeadline(r.decidedAt, delai) : null,
  }));
}

/** F-43 : toutes les clés émises, les actives d'abord puis les plus récentes, avec leur dépense lue en direct. */
export async function listAllKeys(deps: KeyDeps, actor: SessionUser): Promise<AdminKey[]> {
  requireAdmin(actor);
  await markExpired(deps.db, deps.now?.() ?? new Date());
  const rows = await deps.db.accessRequest.findMany({
    where: { kind: "CLE", keyAlias: { not: null }, keyIssuedAt: { not: null } },
    orderBy: { keyIssuedAt: "desc" },
  });
  const cles = await Promise.all(rows.map(async (r) => ({ ...(await toIssuedKey(deps.litellm, r)), holderUid: r.requesterUid, holderEmail: r.requesterEmail })));
  return cles.sort((a, b) => Number(b.status === "CLE_EMISE") - Number(a.status === "CLE_EMISE"));
}

/**
 * F-43 : révocation d'une clé, par son titulaire ou par un admin : suppression dans LiteLLM, demande
 * « Révoquée » (statut final). Le journal d'audit nomme l'auteur.
 */
export async function revokeKey(deps: KeyDeps, user: SessionUser, requestId: string): Promise<void> {
  const request = await activeKeyRequest(deps.db, requestId, (r) => r.requesterUid === user.uid || user.isAdmin);
  await deleteFromGateway(deps.litellm, request.keyTokenId);
  await transitionRequest(deps.db, request, "REVOQUEE");
  await recordAudit(deps.db, { actorUid: user.uid, action: "KEY_REVOKED", targetId: request.id, details: { alias: request.keyAlias } });
  // Le titulaire est prévenu d'une révocation qu'il n'a pas faite lui-même.
  if (user.uid !== request.requesterUid && request.keyAlias) {
    await notifyAdminKeyAction(deps, { ...request, keyAlias: request.keyAlias }, "revocation");
  }
}

/**
 * F-54 : sortie d'une équipe. Révoque les clés émises d'un membre dans cette équipe, sans courriel par clé : le
 * courriel de sortie les nomme. Appelée par le service des équipes, qui contrôle l'autorité de l'acteur. Rend leurs alias.
 */
export async function revokeMemberKeys(deps: KeyDeps, actor: SessionUser, teamId: string, uid: string): Promise<string[]> {
  const cles = await deps.db.accessRequest.findMany({ where: { kind: "CLE", status: "CLE_EMISE", teamId, requesterUid: uid }, orderBy: { keyIssuedAt: "asc" } });
  const alias: string[] = [];
  for (const request of cles) {
    if (request.keyTokenId) await deleteFromGateway(deps.litellm, request.keyTokenId);
    await transitionRequest(deps.db, request, "REVOQUEE");
    await recordAudit(deps.db, { actorUid: actor.uid, action: "KEY_REVOKED", targetId: request.id, details: { alias: request.keyAlias, motif: "sortie_equipe" } });
    if (request.keyAlias) alias.push(request.keyAlias);
  }
  return alias;
}

/**
 * F-41 : remplacement d'une clé perdue. La nouvelle clé reprend les paramètres de l'ancienne et expire à la
 * même date ; son alias porte le rang du remplacement (-2, -3…). L'ancienne est supprimée ; si elle ne peut
 * pas l'être, la nouvelle est retirée aussitôt et rien ne change : une clé perdue ne reste jamais active
 * à côté de sa remplaçante.
 */
export async function replaceKey(deps: KeyDeps, user: SessionUser, requestId: string): Promise<{ key: string; alias: string }> {
  const request = await activeKeyRequest(deps.db, requestId, (r) => r.requesterUid === user.uid);
  const maintenant = deps.now?.() ?? new Date();
  if (request.keyExpiresAt && request.keyExpiresAt <= maintenant) {
    throw new PortalError("transition_interdite", "Cette clé a expiré : demandez son renouvellement.", { cas: "expiree" });
  }
  // Une clé bloquée par un admin ne se remplace pas : le blocage serait contourné.
  const etat = await deps.litellm.getKeyInfo(request.keyTokenId).catch(() => {
    throw new PortalError("passerelle_indisponible", "L'état de la clé n'a pas pu être vérifié.");
  });
  if (etat?.blocked) throw new PortalError("transition_interdite", "Cette clé est bloquée par un administrateur.", { cas: "bloquee" });
  verifierFrequence(deps, user, maintenant);
  const rang = request.keyReplacements + 2;
  let nouvelle;
  try {
    // Durée restante, à la seconde : la nouvelle clé expire à la même date que l'ancienne (jamais, si l'ancienne
    // n'expirait pas), et reprend sa dépense, pour qu'un remplacement ne remette pas le budget à zéro.
    const duree = request.keyExpiresAt ? `${Math.ceil((request.keyExpiresAt.getTime() - maintenant.getTime()) / 1000)}s` : null;
    nouvelle = await deps.litellm.generateKey(keyParams(request, `${keyAlias(request)}-${rang}`, duree, etat?.spend));
  } catch (e) {
    throw e instanceof PortalError ? e : new PortalError("passerelle_indisponible", "La génération de la clé de remplacement a échoué.");
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
    // La date d'expiration d'origine est conservée telle quelle : LiteLLM applique la durée restante à sa propre
    // horloge, un instant plus tard, et son échéance ne diffère que d'une seconde environ.
    data: { keyTokenId: nouvelle.tokenId, keyAlias: nouvelle.alias, keyIssuedAt: maintenant, keyReplacements: { increment: 1 } },
  });
  if (count === 0) {
    await retirerLaNouvelle();
    throw new PortalError("transition_interdite", "La clé a été modifiée entre-temps ; rechargez la page.", { cas: "modifiee" });
  }
  await recordAudit(deps.db, { actorUid: user.uid, action: "KEY_REPLACED", targetId: request.id, details: { alias: nouvelle.alias, ancienAlias: request.keyAlias } });
  return { key: nouvelle.key, alias: nouvelle.alias };
}

/** Blocage et déblocage : appel à la passerelle, message d'échec, action du journal d'audit, courriel au titulaire. */
const BLOCAGE = {
  bloquer: { appel: (l: LiteLLMClient, id: string) => l.blockKey(id), echec: "Le blocage de la clé a échoué.", audit: "KEY_BLOCKED", courriel: "blocage" },
  debloquer: { appel: (l: LiteLLMClient, id: string) => l.unblockKey(id), echec: "Le déblocage de la clé a échoué.", audit: "KEY_UNBLOCKED", courriel: "deblocage" },
} as const;

/** F-43 : blocage d'une clé par un admin (suspension temporaire et réversible) ; la demande reste « Clé émise ». */
export async function blockKey(deps: KeyDeps, actor: SessionUser, requestId: string): Promise<void> {
  await changeBlocking(deps, actor, requestId, BLOCAGE.bloquer);
}

/** F-43 : déblocage d'une clé bloquée par un admin. */
export async function unblockKey(deps: KeyDeps, actor: SessionUser, requestId: string): Promise<void> {
  await changeBlocking(deps, actor, requestId, BLOCAGE.debloquer);
}

async function changeBlocking(deps: KeyDeps, actor: SessionUser, requestId: string, sens: (typeof BLOCAGE)[keyof typeof BLOCAGE]): Promise<void> {
  requireAdmin(actor);
  const request = await activeKeyRequest(deps.db, requestId, () => true);
  try {
    await sens.appel(deps.litellm, request.keyTokenId);
  } catch {
    throw new PortalError("passerelle_indisponible", sens.echec);
  }
  await recordAudit(deps.db, { actorUid: actor.uid, action: sens.audit, targetId: request.id, details: { alias: request.keyAlias } });
  if (request.keyAlias) await notifyAdminKeyAction(deps, { ...request, keyAlias: request.keyAlias }, sens.courriel);
}

/**
 * Demande de clé dont la clé est émise et que l'utilisateur peut gérer. Une clé qu'il ne peut pas gérer est
 * « introuvable » (on ne révèle pas son existence) ; une clé révoquée ou expirée n'est plus active.
 */
async function activeKeyRequest(db: Db, requestId: string, peutGerer: (r: AccessRequest) => boolean): Promise<AccessRequest & { keyTokenId: string }> {
  const request = await db.accessRequest.findUnique({ where: { id: requestId } });
  if (!request || request.kind !== "CLE" || !request.keyTokenId || !request.dataLevel || !peutGerer(request)) {
    throw new PortalError("introuvable", "Clé introuvable.", { objet: "demande_cle" });
  }
  if (request.status !== "CLE_EMISE") throw new PortalError("transition_interdite", "Cette clé n'est plus active.", { cas: "traitee" });
  return { ...request, keyTokenId: request.keyTokenId };
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
