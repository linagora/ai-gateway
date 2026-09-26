import type { Prisma } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";

/** Actions inscrites au journal d'audit (F-52) : décisions sur les demandes, actions sur les clés et sur les équipes. */
export type AuditAction =
  | "REQUEST_CREATED"
  | "RENEWAL_REQUESTED"
  | "REQUEST_APPROVED"
  | "REQUEST_REFUSED"
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
  | "MEMBER_ADDED"
  | "MEMBER_REMOVED";

/** Entrée du journal d'audit : qui, quoi, sur quelle cible, avec quels détails. Jamais de secret. */
export interface AuditEntry {
  actorUid: string;
  action: AuditAction;
  targetId: string | null;
  details: Record<string, string | number | null>;
}

export async function recordAudit(db: Db, entry: AuditEntry): Promise<void> {
  await db.auditLog.create({ data: { ...entry, details: entry.details as Prisma.InputJsonObject } });
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
