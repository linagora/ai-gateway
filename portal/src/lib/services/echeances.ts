import type { Db } from "@/lib/db";
import { recordAudit } from "./audit";
import { type NotificationDeps, notifyExpiryReminder, notifyPickupReminder } from "./notifications";
import { readSettings } from "./settings";

export const JOUR = 86_400_000;

/** Auteur des expirations au journal d'audit : ni le titulaire ni un admin. */
export const SYSTEME = "systeme";

/** Rappels, en jours calendaires à Paris : trois jours avant l'échéance de retrait, sept jours avant l'expiration d'une clé. */
const RAPPEL_RETRAIT = 3;
const RAPPEL_EXPIRATION = 7;

/** Délai de retrait configuré, en jours ; null si aucun n'est configuré (les demandes approuvées n'expirent pas). */
export async function readPickupDays(db: Db): Promise<number | null> {
  const delai = (await readSettings(db)).pickup_days;
  return delai ? Number(delai) : null;
}

/** Échéance de retrait : date d'approbation + délai de retrait. */
export function pickupDeadline(decidedAt: Date, pickupDays: number): Date {
  return new Date(decidedAt.getTime() + pickupDays * JOUR);
}

const JOUR_A_PARIS = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit" });

/** Jours calendaires à Paris entre deux instants : 0 le jour même, 1 la veille, etc. */
export function calendarDaysUntil(from: Date, to: Date): number {
  // « en-CA » donne AAAA-MM-JJ, que Date.parse lit comme minuit UTC : l'écart est un nombre entier de jours.
  const jour = (instant: Date) => Date.parse(JOUR_A_PARIS.format(instant));
  return Math.round((jour(to) - jour(from)) / JOUR);
}

/**
 * Constat des échéances, fait à chaque lecture et par la tâche quotidienne : une demande approuvée non retirée
 * dans le délai de retrait, et une clé arrivée à son expiration, passent en « Expirée ».
 */
export async function markExpired(db: Db, now: Date): Promise<{ demandesExpirees: number; clesExpirees: number }> {
  const delai = await readPickupDays(db);
  const demandes =
    delai !== null
      ? await db.accessRequest.findMany({ where: { kind: "CLE", status: "APPROUVEE", decidedAt: { lte: new Date(now.getTime() - delai * JOUR) } } })
      : [];
  const cles = await db.accessRequest.findMany({ where: { kind: "CLE", status: "CLE_EMISE", keyExpiresAt: { lte: now } } });
  let demandesExpirees = 0;
  let clesExpirees = 0;
  for (const r of demandes) {
    const { count } = await db.accessRequest.updateMany({ where: { id: r.id, status: "APPROUVEE" }, data: { status: "EXPIREE" } });
    if (count === 0) continue;
    demandesExpirees++;
    await recordAudit(db, { actorUid: SYSTEME, action: "REQUEST_EXPIRED", targetId: r.id, details: { teamAlias: r.teamAlias } });
  }
  for (const r of cles) {
    const { count } = await db.accessRequest.updateMany({ where: { id: r.id, status: "CLE_EMISE" }, data: { status: "EXPIREE" } });
    if (count === 0) continue;
    clesExpirees++;
    await recordAudit(db, { actorUid: SYSTEME, action: "KEY_EXPIRED", targetId: r.id, details: { alias: r.keyAlias } });
  }
  return { demandesExpirees, clesExpirees };
}

/** Dépendances de la tâche quotidienne ; la date du jour est injectée pour rendre les échéances testables. */
export interface DailyTaskDeps extends NotificationDeps {
  db: Db;
  now?: () => Date;
}

/** Compte rendu de la tâche quotidienne. */
export interface DailyTaskReport {
  rappelsRetrait: number;
  rappelsExpiration: number;
  demandesExpirees: number;
  clesExpirees: number;
}

/**
 * F-45 : tâche quotidienne, lancée chaque matin à 7 h (heure de Paris). Elle fait expirer ce qui est échu, puis
 * envoie une seule fois chacun les rappels, comptés en jours calendaires : le rappel part le matin du troisième
 * jour avant l'échéance de retrait, et du septième jour avant l'expiration d'une clé.
 */
export async function runDailyTask(deps: DailyTaskDeps): Promise<DailyTaskReport> {
  const maintenant = deps.now?.() ?? new Date();
  const expirations = await markExpired(deps.db, maintenant);
  // Présélection large (deux jours de marge, pour l'heure du jour et les changements d'heure), puis décompte au calendrier.
  const horizon = (jours: number) => new Date(maintenant.getTime() + (jours + 2) * JOUR);
  const delai = await readPickupDays(deps.db);
  let rappelsRetrait = 0;
  let rappelsExpiration = 0;
  if (delai !== null) {
    const aRetirer = await deps.db.accessRequest.findMany({
      where: { kind: "CLE", status: "APPROUVEE", pickupReminderSentAt: null, decidedAt: { lte: new Date(horizon(RAPPEL_RETRAIT).getTime() - delai * JOUR) } },
    });
    for (const r of aRetirer) {
      const echeance = r.decidedAt && pickupDeadline(r.decidedAt, delai);
      if (!echeance || calendarDaysUntil(maintenant, echeance) > RAPPEL_RETRAIT) continue;
      const { count } = await deps.db.accessRequest.updateMany({ where: { id: r.id, pickupReminderSentAt: null }, data: { pickupReminderSentAt: maintenant } });
      if (count === 0) continue;
      rappelsRetrait++;
      await notifyPickupReminder(deps, { to: r.requesterEmail, equipe: r.teamAlias, echeance });
    }
  }
  const aExpirer = await deps.db.accessRequest.findMany({
    where: { kind: "CLE", status: "CLE_EMISE", expiryReminderSentAt: null, keyExpiresAt: { gt: maintenant, lte: horizon(RAPPEL_EXPIRATION) } },
  });
  for (const r of aExpirer) {
    if (!r.keyExpiresAt || !r.keyAlias || calendarDaysUntil(maintenant, r.keyExpiresAt) > RAPPEL_EXPIRATION) continue;
    const { count } = await deps.db.accessRequest.updateMany({ where: { id: r.id, expiryReminderSentAt: null }, data: { expiryReminderSentAt: maintenant } });
    if (count === 0) continue;
    rappelsExpiration++;
    await notifyExpiryReminder(deps, { to: r.requesterEmail, alias: r.keyAlias, echeance: r.keyExpiresAt });
  }
  return { rappelsRetrait, rappelsExpiration, ...expirations };
}
