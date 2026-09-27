import type { SessionUser } from "@/lib/auth-user";
import type { Db } from "@/lib/db";
import { PortalError } from "@/lib/errors";
import { type LiteLLMClient, LiteLLMError } from "@/lib/litellm/client";
import { parActeur, recordAudit } from "./audit";

/** F-02 : à la connexion, crée l'utilisateur dans LiteLLM s'il n'existe pas encore (sans clé). */
export async function provisionUser(deps: { litellm: LiteLLMClient }, user: SessionUser): Promise<void> {
  if (await deps.litellm.getUser(user.uid)) return;
  await deps.litellm.createUser({ userId: user.uid, email: user.email });
}

/**
 * Spécification #71 (garde-fou d'identité) : au premier accès d'un collaborateur par une intégration, un uid encore
 * inconnu (ni utilisateur de la passerelle, ni auteur d'une demande, titulaire d'un abonnement ou responsable dans le
 * portail) dont l'adresse appartient déjà à un autre uid est refusé et inscrit au journal d'audit, sans provisionnement :
 * une erreur de format d'identifiant chez l'intégration ne crée jamais un second collaborateur. Sinon, le collaborateur
 * est provisionné comme à sa connexion au portail.
 */
export async function provisionIntegrationUser(deps: { db: Db; litellm: LiteLLMClient }, acteur: SessionUser): Promise<void> {
  if (await deps.litellm.getUser(acteur.uid)) return;
  if (!(await connuDuPortail(deps.db, acteur.uid))) {
    const autres = await autresTitulaires(deps, acteur);
    if (autres.length > 0) throw await refusDIdentite(deps.db, acteur, autres);
  }
  try {
    await deps.litellm.createUser({ userId: acteur.uid, email: acteur.email });
  } catch (e) {
    // La passerelle refuse elle-même une adresse déjà prise par un autre de ses utilisateurs (HTTP 409) : même refus.
    if (e instanceof LiteLLMError && e.status === 409) throw await refusDIdentite(deps.db, acteur, []);
    throw e;
  }
}

/** Refus d'une identité incohérente, inscrit au journal d'audit avec les uid qui ont déjà l'adresse, quand ils sont connus. */
async function refusDIdentite(db: Db, acteur: SessionUser, autres: string[]): Promise<PortalError> {
  await recordAudit(db, {
    ...parActeur(acteur),
    action: "INTEGRATION_IDENTITY_REFUSED",
    targetId: null,
    details: { email: acteur.email, uidExistants: autres.join(", ") || null },
  });
  return new PortalError("identite_incoherente", `L'uid ${acteur.uid} est inconnu et son adresse appartient déjà à un autre uid.`);
}

/** Trace de l'uid dans le portail : une demande, un abonnement ou une désignation comme responsable. */
async function connuDuPortail(db: Db, uid: string): Promise<boolean> {
  const traces = await Promise.all([
    db.accessRequest.findFirst({ where: { requesterUid: uid }, select: { id: true } }),
    db.subscription.findFirst({ where: { holderUid: uid }, select: { id: true } }),
    db.teamManager.findFirst({ where: { uid }, select: { uid: true } }),
  ]);
  return traces.some(Boolean);
}

/** Autres uid à qui appartient l'adresse, sans tenir compte de sa casse : dans le portail, et parmi les utilisateurs de la passerelle. */
async function autresTitulaires(deps: { db: Db; litellm: LiteLLMClient }, { uid, email }: SessionUser): Promise<string[]> {
  const memeAdresse = { equals: email, mode: "insensitive" as const };
  const [demandes, abonnements, responsables, passerelle] = await Promise.all([
    deps.db.accessRequest.findMany({ where: { requesterEmail: memeAdresse, requesterUid: { not: uid } }, distinct: ["requesterUid"], select: { requesterUid: true } }),
    deps.db.subscription.findMany({ where: { holderEmail: memeAdresse, holderUid: { not: uid } }, distinct: ["holderUid"], select: { holderUid: true } }),
    deps.db.teamManager.findMany({ where: { email: memeAdresse, uid: { not: uid } }, distinct: ["uid"], select: { uid: true } }),
    deps.litellm.findUsersByEmail(email),
  ]);
  const uids = [...demandes.map((d) => d.requesterUid), ...abonnements.map((a) => a.holderUid), ...responsables.map((r) => r.uid), ...passerelle.map((u) => u.userId)];
  return [...new Set(uids.filter((autre) => autre !== uid))];
}
