import type { Prisma } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";
import { STATUTS_PAS_ENCORE_DECIDES } from "@/lib/policy";

/*
 * Demandes « en cours », pour les requêtes sur les demandes (ticket #94) : toutes partent des statuts d'une demande pas
 * encore décidée, définis une seule fois avec les règles de transition.
 */

/** Demandes pas encore décidées, ni approuvées ni refusées. */
export const PAS_ENCORE_DECIDEES = { status: { in: [...STATUTS_PAS_ENCORE_DECIDES] } } satisfies Prisma.AccessRequestWhereInput;

/**
 * Demandes en cours dans une équipe (F-54, #38) : pas encore décidées, demandes de clé approuvées dont la clé n'est pas
 * retirée, et demandes d'abonnement approuvées pas encore déclarées. Une demande d'accès approuvée est close : le
 * salarié est entré dans l'équipe.
 */
export const DEMANDES_EN_COURS: Prisma.AccessRequestWhereInput = {
  OR: [PAS_ENCORE_DECIDEES, { kind: { in: ["CLE", "ABONNEMENT"] }, status: "APPROUVEE" }],
};

/** Demande portant sur un abonnement (renouvellement ou changement d'offre) encore en cours : pas encore décidée, ou approuvée sans être déclarée. */
export const DEMANDE_SUR_ABONNEMENT_EN_COURS = {
  status: { in: [...STATUTS_PAS_ENCORE_DECIDES, "APPROUVEE" as const] },
} satisfies Prisma.AccessRequestWhereInput;

/** Demandes de hausse du budget de cette clé pas encore décidées. */
const haussesDeLaCle = (keyRequestId: string) => ({ kind: "BUDGET", raisesBudgetOfRequestId: keyRequestId, ...PAS_ENCORE_DECIDEES }) satisfies Prisma.AccessRequestWhereInput;

/** Une demande de hausse du budget de cette clé est-elle en cours ? Une seule à la fois, jamais avec un renouvellement. */
export async function hausseEnCours(db: Db, keyRequestId: string): Promise<boolean> {
  return (await db.accessRequest.count({ where: haussesDeLaCle(keyRequestId) })) > 0;
}

/** Révoquée, expirée ou renouvelée, une clé emporte les demandes de hausse de son budget pas encore décidées. */
export async function annulerHaussesDeLaCle(db: Db, keyRequestId: string): Promise<void> {
  await db.accessRequest.updateMany({ where: haussesDeLaCle(keyRequestId), data: { status: "ANNULEE" } });
}

/** Alias de la clé visée par chaque demande de hausse du budget ; l'index suit l'identifiant de la demande. */
export async function aliasDesCleVisees(db: Db, demandes: { id: string; kind: string; raisesBudgetOfRequestId: string | null }[]): Promise<Map<string, string>> {
  const visees = demandes.filter((d) => d.kind === "BUDGET" && d.raisesBudgetOfRequestId);
  if (visees.length === 0) return new Map();
  const cles = await db.accessRequest.findMany({ where: { id: { in: visees.map((d) => d.raisesBudgetOfRequestId as string) } }, select: { id: true, keyAlias: true } });
  const alias = new Map(cles.map((c) => [c.id, c.keyAlias]));
  return new Map(visees.flatMap((d) => (alias.get(d.raisesBudgetOfRequestId as string) ? [[d.id, alias.get(d.raisesBudgetOfRequestId as string) as string] as const] : [])));
}
