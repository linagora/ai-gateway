import type { SessionUser } from "@/lib/auth-user";
import type { Db } from "@/lib/db";
import { PortalError } from "@/lib/errors";

/**
 * Autorité sur les équipes (F-54) : un admin les a toutes (null) ; un responsable d'équipe, les seules équipes dont il
 * est responsable ; les autres salariés, aucune. Relue dans la base à chaque action : un rôle retiré cesse aussitôt de
 * donner des droits.
 */
export async function equipesGerees(db: Db, actor: SessionUser): Promise<string[] | null> {
  if (actor.isAdmin) return null;
  const rows = await db.teamManager.findMany({ where: { uid: actor.uid }, select: { teamId: true } });
  return rows.map((r) => r.teamId);
}

/** Accès à la gestion : admins et responsables d'équipe ; rend les équipes gérées (null : toutes). */
export async function requireGestion(db: Db, actor: SessionUser): Promise<string[] | null> {
  const equipes = await equipesGerees(db, actor);
  if (equipes !== null && equipes.length === 0) throw new PortalError("interdit", "Action réservée aux administrateurs et aux responsables d'équipe.");
  return equipes;
}

/** Filtre des demandes et des clés sur les équipes gérées (aucun pour un admin). */
export function dansEquipes(equipes: string[] | null): { teamId?: { in: string[] } } {
  return equipes === null ? {} : { teamId: { in: equipes } };
}

/**
 * Contrôle d'autorité sur une équipe : admin, ou responsable de cette équipe. Hors de son autorité, l'équipe, la demande
 * ou la clé visée est « introuvable » (`objet` précise laquelle, pour le message).
 */
export async function requireAutorite(db: Db, actor: SessionUser, teamId: string, objet: string): Promise<void> {
  const equipes = await requireGestion(db, actor);
  if (equipes !== null && !equipes.includes(teamId)) throw new PortalError("introuvable", `${actor.uid} n'a pas autorité sur l'équipe ${teamId}.`, { objet });
}

/** Adresses des responsables d'une équipe, hors ceux exclus (auteur d'un changement, demandeur) : destinataires en plus des admins. */
export async function managerEmails(db: Db, teamId: string, exclus: string[]): Promise<string[]> {
  const rows = await db.teamManager.findMany({ where: { teamId, uid: { notIn: exclus } }, orderBy: { uid: "asc" } });
  return rows.map((m) => m.email).filter(Boolean);
}
