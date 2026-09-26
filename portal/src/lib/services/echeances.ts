import type { Db } from "@/lib/db";
import type { LiteLLMClient, LiteLLMTeam } from "@/lib/litellm/client";
import { recordAudit } from "./audit";
import { managerEmails } from "./autorite";
import { type NotificationDeps, notifyExpiryReminder, notifyPickupReminder, notifyTeamBudgetAlert } from "./notifications";
import { readSettings } from "./settings";

export const JOUR = 86_400_000;

/** Auteur des expirations au journal d'audit : ni le titulaire ni un admin. */
export const SYSTEME = "systeme";

/**
 * Rappels, en jours calendaires à Paris : trois jours avant l'échéance de retrait ; un mois, sept jours et la veille
 * de l'expiration d'une clé (ticket #27), pour les seuls délais plus courts que la durée de validité de la clé.
 */
const RAPPEL_RETRAIT = 3;
const RAPPELS_EXPIRATION = [30, 7, 1];

/** F-54 : seuils d'alerte du budget d'équipe, en pourcentage du budget, du plus bas au plus haut. */
const SEUILS_BUDGET = [80, 100];

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
  litellm: LiteLLMClient;
  now?: () => Date;
}

/** Compte rendu de la tâche quotidienne. */
export interface DailyTaskReport {
  rappelsRetrait: number;
  rappelsExpiration: number;
  demandesExpirees: number;
  clesExpirees: number;
  alertesBudget: number;
}

/**
 * F-45 : tâche quotidienne, lancée chaque matin à 7 h (heure de Paris). Elle fait expirer ce qui est échu, puis
 * envoie une seule fois chacun les rappels, comptés en jours calendaires : le matin du troisième jour avant
 * l'échéance de retrait ; un mois, sept jours et un jour avant l'expiration d'une clé, selon sa durée. Après des
 * jours sans tâche, seul le rappel d'expiration le plus proche de l'échéance part. Elle finit par les alertes de
 * budget d'équipe (F-54).
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
      await notifyPickupReminder(deps, r, echeance);
    }
  }
  const aExpirer = await deps.db.accessRequest.findMany({
    where: { kind: "CLE", status: "CLE_EMISE", keyExpiresAt: { gt: maintenant, lte: horizon(Math.max(...RAPPELS_EXPIRATION)) } },
  });
  for (const r of aExpirer) {
    if (!r.keyExpiresAt || !r.keyAlias) continue;
    const jours = calendarDaysUntil(maintenant, r.keyExpiresAt);
    // Rappels dus : délai atteint, plus court que la durée de la clé, et plus proche de l'échéance que le dernier envoyé.
    const dus = RAPPELS_EXPIRATION.filter(
      (delai) => jours <= delai && delai < (r.approvedDays ?? Infinity) && (r.expiryReminderLead === null || delai < r.expiryReminderLead),
    );
    if (dus.length === 0) continue;
    const { count } = await deps.db.accessRequest.updateMany({
      where: { id: r.id, expiryReminderLead: r.expiryReminderLead },
      data: { expiryReminderLead: Math.min(...dus), expiryReminderSentAt: maintenant },
    });
    if (count === 0) continue;
    rappelsExpiration++;
    await notifyExpiryReminder(deps, { ...r, keyAlias: r.keyAlias, keyExpiresAt: r.keyExpiresAt }, jours);
  }
  return { rappelsRetrait, rappelsExpiration, ...expirations, alertesBudget: await alerterBudgets(deps, maintenant) };
}

/**
 * F-54 : alertes de budget d'équipe. Pour chaque équipe plafonnée, le plus haut seuil atteint (80 puis 100 %) est
 * annoncé une seule fois par période aux admins et aux responsables de l'équipe ; une nouvelle période, ou un nouveau
 * budget, fait repartir les alertes. Une passerelle injoignable n'empêche pas le reste de la tâche.
 */
async function alerterBudgets(deps: DailyTaskDeps, maintenant: Date): Promise<number> {
  let equipes: LiteLLMTeam[];
  try {
    equipes = await deps.litellm.listTeams();
  } catch (e) {
    console.error(`Alertes de budget d'équipe non vérifiées : ${e instanceof Error ? e.message : "erreur inconnue"}`);
    return 0;
  }
  let alertes = 0;
  for (const equipe of equipes) {
    const budget = equipe.maxBudget;
    // Sans plafond (budget à 0), une équipe n'est jamais alertée.
    if (!budget) continue;
    const seuil = SEUILS_BUDGET.filter((s) => equipe.spend * 100 >= budget * s).at(-1);
    if (seuil === undefined) continue;
    const suivi = await deps.db.teamBudgetAlert.findUnique({ where: { teamId: equipe.teamId } });
    const memePeriode = suivi !== null && suivi.budget.toNumber() === budget && suivi.resetAt?.getTime() === equipe.budgetResetAt?.getTime();
    if (memePeriode && suivi.level >= seuil) continue;
    const annonce = { resetAt: equipe.budgetResetAt, budget, level: seuil, sentAt: maintenant };
    // Écriture conditionnelle, comme pour les rappels : deux tâches simultanées n'envoient pas deux fois une alerte.
    const { count } = suivi
      ? await deps.db.teamBudgetAlert.updateMany({ where: { teamId: equipe.teamId, sentAt: suivi.sentAt }, data: annonce })
      : await deps.db.teamBudgetAlert.createMany({ data: [{ teamId: equipe.teamId, ...annonce }], skipDuplicates: true });
    if (count === 0) continue;
    alertes++;
    await notifyTeamBudgetAlert(
      deps,
      { teamId: equipe.teamId, equipe: equipe.teamAlias, seuil, depense: equipe.spend, budget, fin: equipe.budgetResetAt },
      await managerEmails(deps.db, equipe.teamId, []),
    );
  }
  return alertes;
}
