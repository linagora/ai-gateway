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
