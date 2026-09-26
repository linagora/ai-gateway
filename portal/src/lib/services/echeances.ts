import type { Db } from "@/lib/db";
import type { LiteLLMClient, LiteLLMTeam } from "@/lib/litellm/client";
import { recordAudit } from "./audit";
import { managerEmails } from "./autorite";
import { calendarDaysUntil, JOUR, pickupDeadline, readPickupDays, SYSTEME } from "./delais";
import {
  type NotificationDeps,
  notifyDeclarationReminder,
  notifyExpiryReminder,
  notifyPickupReminder,
  notifySubscriptionExpiryReminder,
  notifyTeamBudgetAlert,
  notifyUndeclaredTermination,
} from "./notifications";
import { enregistrerPrelevementsEchus } from "./prelevements";
import { requestTerminationsAtExpiry } from "./resiliations";

/**
 * Rappels, en jours calendaires à Paris : trois jours avant l'échéance de retrait ; un mois, sept jours et la veille
 * de l'expiration d'une clé (ticket #27) ou de l'échéance d'un abonnement (ticket #59), pour les seuls délais plus
 * courts que leur durée de validité.
 */
const RAPPEL_RETRAIT = 3;
const RAPPELS_EXPIRATION = [30, 7, 1];

/** F-54 : seuils d'alerte du budget d'équipe, en pourcentage du budget, du plus bas au plus haut. */
const SEUILS_BUDGET = [80, 100];

/**
 * Constat des échéances, fait à chaque lecture et par la tâche quotidienne : une demande approuvée non retirée
 * dans le délai de retrait, et une clé arrivée à son expiration, passent en « Expirée ».
 */
export async function markExpired(db: Db, now: Date): Promise<{ demandesExpirees: number; clesExpirees: number }> {
  const delai = await readPickupDays(db);
  // Une demande de clé approuvée non retirée, ou d'abonnement approuvée non déclarée (spécification #51), expire.
  const demandes =
    delai !== null
      ? await db.accessRequest.findMany({ where: { kind: { in: ["CLE", "ABONNEMENT"] }, status: "APPROUVEE", decidedAt: { lte: new Date(now.getTime() - delai * JOUR) } } })
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
  rappelsDeclaration: number;
  rappelsExpiration: number;
  rappelsEcheance: number;
  demandesExpirees: number;
  clesExpirees: number;
  prelevements: number;
  demandesResiliation: number;
  alertesResiliation: number;
  alertesBudget: number;
}

/**
 * F-45 : tâche quotidienne, lancée chaque matin à 7 h (heure de Paris). Elle fait expirer ce qui est échu, puis
 * envoie une seule fois chacun les rappels, comptés en jours calendaires : le matin du troisième jour avant
 * l'échéance de retrait ; un mois, sept jours et un jour avant l'expiration d'une clé, selon sa durée. Après des
 * jours sans tâche, seul le rappel d'expiration le plus proche de l'échéance part ; de même pour l'échéance d'un
 * abonnement. Elle compte ensuite les prélèvements échus des abonnements (spécification #51), rattrapage compris, fait
 * une demande de résiliation des abonnements arrivés à échéance sans renouvellement, alerte une fois des résiliations
 * demandées et non déclarées dans le délai de retrait, et finit par les alertes de budget d'équipe (F-54).
 */
export async function runDailyTask(deps: DailyTaskDeps): Promise<DailyTaskReport> {
  const maintenant = deps.now?.() ?? new Date();
  const expirations = await markExpired(deps.db, maintenant);
  // Présélection large (deux jours de marge, pour l'heure du jour et les changements d'heure), puis décompte au calendrier.
  const horizon = (jours: number) => new Date(maintenant.getTime() + (jours + 2) * JOUR);
  const delai = await readPickupDays(deps.db);
  let rappelsRetrait = 0;
  let rappelsDeclaration = 0;
  let rappelsExpiration = 0;
  if (delai !== null) {
    // Clé à retirer ou abonnement à déclarer (spécification #51) : même délai, même rappel trois jours avant.
    const enAttente = await deps.db.accessRequest.findMany({
      where: {
        kind: { in: ["CLE", "ABONNEMENT"] },
        status: "APPROUVEE",
        pickupReminderSentAt: null,
        decidedAt: { lte: new Date(horizon(RAPPEL_RETRAIT).getTime() - delai * JOUR) },
      },
      include: { offer: true },
    });
    for (const r of enAttente) {
      const echeance = pickupDeadline(r.decidedAt, delai);
      if (!echeance || calendarDaysUntil(maintenant, echeance) > RAPPEL_RETRAIT) continue;
      const { count } = await deps.db.accessRequest.updateMany({ where: { id: r.id, pickupReminderSentAt: null }, data: { pickupReminderSentAt: maintenant } });
      if (count === 0) continue;
      if (r.kind === "ABONNEMENT" && r.offer) {
        rappelsDeclaration++;
        await notifyDeclarationReminder(deps, r, r.offer, echeance);
      } else {
        rappelsRetrait++;
        await notifyPickupReminder(deps, r, echeance);
      }
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
  const rappelsEcheance = await rappelerEcheances(deps, maintenant, horizon(Math.max(...RAPPELS_EXPIRATION)));
  const prelevements = await enregistrerPrelevementsEchus(deps.db, maintenant);
  const demandesResiliation = await requestTerminationsAtExpiry(deps, maintenant);
  const alertesResiliation = delai !== null ? await alerterResiliationsNonDeclarees(deps, maintenant, delai) : 0;
  return {
    rappelsRetrait,
    rappelsDeclaration,
    rappelsExpiration,
    rappelsEcheance,
    ...expirations,
    prelevements,
    demandesResiliation,
    alertesResiliation,
    alertesBudget: await alerterBudgets(deps, maintenant),
  };
}

/**
 * Ticket #59 : rappels d'échéance des abonnements actifs, au titulaire, un mois, sept jours et la veille, chacun une
 * seule fois et seulement s'il est plus court que la durée de l'abonnement (de sa souscription à son échéance). Rend le
 * nombre de rappels envoyés.
 */
async function rappelerEcheances(deps: DailyTaskDeps, maintenant: Date, horizon: Date): Promise<number> {
  const abonnements = await deps.db.subscription.findMany({ where: { status: "ACTIF", expiresAt: { gt: maintenant, lte: horizon } }, include: { offer: true } });
  let rappels = 0;
  for (const a of abonnements) {
    const jours = calendarDaysUntil(maintenant, a.expiresAt);
    const duree = (a.expiresAt.getTime() - a.subscribedAt.getTime()) / JOUR;
    const dus = RAPPELS_EXPIRATION.filter((delai) => jours <= delai && delai < duree && (a.expiryReminderLead === null || delai < a.expiryReminderLead));
    if (dus.length === 0) continue;
    // Écriture conditionnelle : deux tâches simultanées n'envoient pas deux fois le même rappel.
    const { count } = await deps.db.subscription.updateMany({
      where: { id: a.id, expiryReminderLead: a.expiryReminderLead },
      data: { expiryReminderLead: Math.min(...dus), expiryReminderSentAt: maintenant },
    });
    if (count === 0) continue;
    rappels++;
    await notifySubscriptionExpiryReminder(deps, a, a.offer, jours);
  }
  return rappels;
}

/**
 * Ticket #58 : une résiliation demandée et toujours pas déclarée au terme du délai de retrait est signalée, une seule
 * fois, aux admins et aux responsables de l'équipe de l'abonnement (hors son titulaire). Rend le nombre d'alertes.
 */
async function alerterResiliationsNonDeclarees(deps: DailyTaskDeps, maintenant: Date, delai: number): Promise<number> {
  const enRetard = await deps.db.subscription.findMany({
    where: { status: "A_RESILIER", terminationAlertSentAt: null, terminationRequestedAt: { lte: new Date(maintenant.getTime() - delai * JOUR) } },
    include: { offer: true },
  });
  let alertes = 0;
  for (const abonnement of enRetard) {
    // Écriture conditionnelle, comme pour les rappels : deux tâches simultanées n'alertent pas deux fois.
    const { count } = await deps.db.subscription.updateMany({
      where: { id: abonnement.id, status: "A_RESILIER", terminationAlertSentAt: null },
      data: { terminationAlertSentAt: maintenant },
    });
    if (count === 0) continue;
    alertes++;
    await notifyUndeclaredTermination(deps, abonnement, abonnement.offer, await managerEmails(deps.db, abonnement.teamId, [abonnement.holderUid]));
  }
  return alertes;
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
