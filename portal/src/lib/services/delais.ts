import type { Db } from "@/lib/db";
import { readSettings } from "./settings";

export const JOUR = 86_400_000;

/** Auteur au journal d'audit des actions de la tâche quotidienne (expirations, demandes de résiliation) : ni un salarié ni un admin. */
export const SYSTEME = "systeme";

/** Délai de retrait configuré, en jours ; null si aucun n'est configuré (les demandes approuvées n'expirent pas). */
export async function readPickupDays(db: Db): Promise<number | null> {
  const delai = (await readSettings(db)).pickup_days;
  return delai ? Number(delai) : null;
}

/**
 * Échéance du délai de retrait (retrait d'une clé, déclaration d'un abonnement ou de sa résiliation) : la date de départ
 * plus le délai ; null sans délai configuré ou sans date de départ.
 */
export function pickupDeadline(depuis: Date | null, pickupDays: number | null): Date | null {
  return depuis && pickupDays !== null ? new Date(depuis.getTime() + pickupDays * JOUR) : null;
}

const JOUR_A_PARIS = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit" });

/** Jours calendaires à Paris entre deux instants : 0 le jour même, 1 la veille, etc. */
export function calendarDaysUntil(from: Date, to: Date): number {
  // « en-CA » donne AAAA-MM-JJ, que Date.parse lit comme minuit UTC : l'écart est un nombre entier de jours.
  const jour = (instant: Date) => Date.parse(JOUR_A_PARIS.format(instant));
  return Math.round((jour(to) - jour(from)) / JOUR);
}

/** Rappels d'expiration d'une clé (ticket #27) et d'échéance d'un abonnement (ticket #59), en jours calendaires avant elle. */
export const RAPPELS_EXPIRATION = [30, 7, 1];

/**
 * Horizon d'une présélection d'échéances à au plus `jours` jours : deux jours de marge, pour l'heure du jour et les
 * changements d'heure, avant le décompte au calendrier.
 */
export function horizonDeRappel(maintenant: Date, jours: number): Date {
  return new Date(maintenant.getTime() + (jours + 2) * JOUR);
}

/**
 * Rappels d'expiration ou d'échéance dus, à `jours` jours calendaires de l'échéance : délai atteint, plus court que la
 * durée de validité (`duree`, en jours), et plus proche de l'échéance que le dernier rappel envoyé (`dernier`).
 */
export function rappelsDus(jours: number, duree: number, dernier: number | null): number[] {
  return RAPPELS_EXPIRATION.filter((delai) => jours <= delai && delai < duree && (dernier === null || delai < dernier));
}
