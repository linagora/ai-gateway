import type { Prisma } from "@/generated/prisma/client";
import type { SessionUser } from "@/lib/auth-user";
import type { Db } from "@/lib/db";

/**
 * Actions inscrites au journal d'audit (F-52) : décisions sur les demandes, actions sur les clés et sur les équipes,
 * changements du registre des intégrations (spécification #71) et publication des nouveautés (spécification #124).
 */
export type AuditAction =
  | "REQUEST_CREATED"
  | "RENEWAL_REQUESTED"
  | "REQUEST_AGREED"
  | "REQUEST_APPROVED"
  | "REQUEST_REFUSED"
  | "REQUEST_COMPLETED"
  | "REQUEST_CANCELLED"
  | "COMPLETION_REQUESTED"
  | "MEMBERSHIP_APPROVED"
  | "KEY_GENERATED"
  | "KEY_REPLACED"
  | "KEY_REVOKED"
  | "KEY_BLOCKED"
  | "KEY_UNBLOCKED"
  | "REQUEST_EXPIRED"
  | "KEY_EXPIRED"
  | "TEAM_CREATED"
  | "TEAM_RENAMED"
  | "TEAM_BUDGET_SET"
  | "TEAM_DELETED"
  | "MEMBER_ADDED"
  | "MEMBER_REMOVED"
  | "MANAGER_DESIGNATED"
  | "MANAGER_REMOVED"
  | "OFFER_CREATED"
  | "OFFER_UPDATED"
  | "OFFER_HIDDEN"
  | "SUBSCRIPTION_DECLARED"
  | "SUBSCRIPTION_AMOUNT_CORRECTED"
  | "SUBSCRIPTION_TERMINATION_REQUESTED"
  | "SUBSCRIPTION_TERMINATED"
  | "SUBSCRIPTION_REATTACHED"
  | "SUBSCRIPTION_OFFER_CHANGED"
  | "CHARGES_TRANSMITTED"
  | "INTEGRATION_CREATED"
  | "INTEGRATION_UPDATED"
  | "INTEGRATION_KEY_ADDED"
  | "INTEGRATION_KEY_REMOVED"
  | "INTEGRATION_ACTIVATED"
  | "INTEGRATION_DEACTIVATED"
  | "INTEGRATION_IDENTITY_REFUSED"
  | "NEWS_CREATED"
  | "NEWS_UPDATED"
  | "NEWS_PUBLISHED"
  | "NEWS_DELETED";

/** Entrée du journal d'audit : qui, quoi, sur quelle cible, avec quels détails. Jamais de secret. */
export interface AuditEntry {
  actorUid: string;
  action: AuditAction;
  targetId: string | null;
  details: Record<string, string | number | boolean | null>;
  /** Canal de l'action, quand elle vient d'une intégration (spécification #71) : inscrit dans les détails. */
  canal?: string;
}

/** Auteur d'une entrée du journal : l'acteur, avec son canal s'il agit par une intégration. */
export const parActeur = (acteur: SessionUser): Pick<AuditEntry, "actorUid" | "canal"> => ({ actorUid: acteur.uid, canal: acteur.canal });

export async function recordAudit(db: Db, { canal, ...entry }: AuditEntry): Promise<void> {
  const details = canal ? { ...entry.details, canal } : entry.details;
  await db.auditLog.create({ data: { ...entry, details: details as Prisma.InputJsonObject } });
}

/** Entrées du journal, de la plus ancienne à la plus récente. */
export async function listAudit(db: Db): Promise<(AuditEntry & { at: Date })[]> {
  const rows = await db.auditLog.findMany({ orderBy: { id: "asc" } });
  return rows.map((r) => ({
    at: r.at,
    actorUid: r.actorUid,
    action: r.action as AuditAction,
    targetId: r.targetId,
    details: r.details as AuditEntry["details"],
  }));
}
