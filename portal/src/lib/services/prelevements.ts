import type { Subscription } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";

/** Minuit (UTC) du jour d'un instant : les dates d'un abonnement se comptent en jours. */
export const jourUtc = (instant: Date) => new Date(Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate()));

/**
 * Dates des prélèvements d'un abonnement souscrit le jour `souscription`, jusqu'au jour `jusqua` inclus : le jour de
 * souscription, puis le même jour de chaque mois, ramené au dernier jour du mois quand il n'existe pas (31 janvier,
 * 28 ou 29 février, 31 mars…).
 */
export function datesDePrelevement(souscription: Date, jusqua: Date): Date[] {
  const [annee, mois, jour] = [souscription.getUTCFullYear(), souscription.getUTCMonth(), souscription.getUTCDate()];
  const dates: Date[] = [];
  for (let decalage = 0; ; decalage++) {
    const dernierJour = new Date(Date.UTC(annee, mois + decalage + 1, 0)).getUTCDate();
    const date = new Date(Date.UTC(annee, mois + decalage, Math.min(jour, dernierJour)));
    if (date > jusqua) return dates;
    dates.push(date);
  }
}

/**
 * Enregistre les prélèvements échus d'un abonnement, jusqu'au jour `jusqua` : chacun avec le montant alors en vigueur
 * et l'équipe de l'abonnement, une seule fois par date (rattrapage sans doublon). Rend le nombre de prélèvements créés.
 */
export async function enregistrerPrelevements(db: Db, abonnement: Subscription, jusqua: Date): Promise<number> {
  const dates = datesDePrelevement(abonnement.subscribedAt, jourUtc(jusqua));
  if (dates.length === 0) return 0;
  const { count } = await db.subscriptionCharge.createMany({
    data: dates.map((chargedOn) => ({
      subscriptionId: abonnement.id,
      chargedOn,
      amountEur: abonnement.monthlyAmountEur,
      teamId: abonnement.teamId,
      teamAlias: abonnement.teamAlias,
    })),
    skipDuplicates: true,
  });
  return count;
}

/** Tâche quotidienne : prélèvements échus de tous les abonnements non résiliés ; rend le nombre de prélèvements créés. */
export async function enregistrerPrelevementsEchus(db: Db, maintenant: Date): Promise<number> {
  const abonnements = await db.subscription.findMany({ where: { status: { not: "RESILIE" } } });
  let crees = 0;
  for (const abonnement of abonnements) crees += await enregistrerPrelevements(db, abonnement, maintenant);
  return crees;
}
