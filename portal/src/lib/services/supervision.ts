import type { ModelHealth } from "@/generated/prisma/client";
import type { SessionUser } from "@/lib/auth-user";
import type { Db } from "@/lib/db";
import type { ApiKind, CodeErreurSonde, LiteLLMClient, LiteLLMModel, ProbeResult } from "@/lib/litellm/client";
import type { Langue } from "@/lib/langue";
import type { DataLevel } from "@/lib/policy";
import { requireAdmin } from "@/lib/rbac";
import { type NotificationDeps, notifyModelsDown, notifyModelsRestored } from "./notifications";

/**
 * Supervision des modèles mis à disposition des collaborateurs (ticket #142) : chaque modèle visible du catalogue est sondé par la route
 * d'inférence, à l'intervalle de SUPERVISION_INTERVAL_MINUTES (minuterie du portail, src/instrumentation.ts), pour que les
 * admins apprennent une panne avant les collaborateurs.
 * La liste n'est écrite nulle part : elle est relue à chaque passage dans le catalogue et dans LiteLLM, et la sonde
 * dépend du type d'API déclaré par la passerelle, non du modèle.
 */

/** Intervalle maximal entre deux passages, en minutes : un jour. */
export const INTERVALLE_MAXIMAL = 24 * 60;

/**
 * Intervalle de SUPERVISION_INTERVAL_MINUTES, en minutes entières, d'une minute à un jour ; null si la sonde automatique est
 * désactivée : variable absente, 0, ou valeur hors de ces bornes (l'onglet le signale, le bouton « Sonder maintenant » reste).
 */
export function lireIntervalle(valeur: string | undefined): number | null {
  const minutes = Number(valeur);
  return Number.isInteger(minutes) && minutes >= 1 && minutes <= INTERVALLE_MAXIMAL ? minutes : null;
}

/** Échecs consécutifs avant l'alerte : un échec isolé (coupure de quelques secondes) n'alerte personne. */
export const SEUIL_ALERTE = 2;

/** Alerte qu'appelle une sonde : la panne, après SEUIL_ALERTE échecs, ou le rétablissement d'un modèle annoncé en panne. */
export type Alerte = "panne" | "retablissement" | null;

/** État enregistré d'un modèle, sans son nom. */
export type EtatModele = Omit<ModelHealth, "modelName">;

/**
 * Règle pure : état d'un modèle après une sonde, et l'alerte qu'elle appelle. `since` est la date du dernier changement
 * d'état ; une seule alerte de panne par panne, et un rétablissement n'est annoncé que si la panne l'a été.
 */
export function etatApresSonde(precedent: EtatModele | null, sonde: ProbeResult, now: Date): { etat: EtatModele; alerte: Alerte } {
  const repond = sonde.error === null && sonde.errorCode === null;
  const mesure = { checkedAt: now, latencyMs: sonde.latencyMs, httpStatus: sonde.status, error: sonde.error, errorCode: sonde.errorCode };
  const since = precedent && precedent.healthy === repond ? precedent.since : now;
  if (repond) {
    const alerte: Alerte = precedent?.alertedAt ? "retablissement" : null;
    return { etat: { ...mesure, healthy: true, since, failures: 0, alertedAt: null }, alerte };
  }
  const failures = (precedent && !precedent.healthy ? precedent.failures : 0) + 1;
  const alerter = failures >= SEUIL_ALERTE && !precedent?.alertedAt;
  return {
    etat: { ...mesure, healthy: false, since, failures, alertedAt: alerter ? now : (precedent?.alertedAt ?? null) },
    alerte: alerter ? "panne" : null,
  };
}

export interface SupervisionDeps extends NotificationDeps {
  db: Db;
  litellm: LiteLLMClient;
  /** Intervalle entre deux passages, en minutes, cité par le courriel de panne ; null si la sonde automatique est désactivée. */
  intervalleMinutes?: number | null;
  now?: () => Date;
}

/** Modèle en échec dans le compte rendu : le message d'erreur, ou le code d'une erreur propre à la sonde. */
export interface ModeleEnEchec {
  modelName: string;
  error: string | null;
  errorCode: CodeErreurSonde | null;
}

/** Compte rendu d'un passage de la supervision. */
export interface RapportSupervision {
  sondes: number;
  /** Modèles en panne : au moins SEUIL_ALERTE échecs consécutifs ; admins prévenus, sauf courriel non parti (alerte relancée). */
  enPanne: ModeleEnEchec[];
  /** Modèles dégradés : en échec depuis moins de SEUIL_ALERTE sondes, sans alerte encore. */
  degrades: ModeleEnEchec[];
  nonSupervises: string[];
  alertesPanne: string[];
  retablissements: string[];
}

/** Passage en cours, sur globalThis comme la minuterie : commun à la minuterie, à « Sonder maintenant » et à la route interne. */
const memoire = globalThis as typeof globalThis & { passageSupervision?: Promise<RapportSupervision> };

/**
 * Un passage de la supervision : sonde de chaque modèle visible du catalogue, en parallèle, mise à jour de son état, puis
 * un seul courriel aux admins pour les pannes nouvelles et un pour les rétablissements (une panne d'OpenRouter touche
 * d'un coup tous ses modèles). Un modèle masqué ou retiré du catalogue n'est plus suivi. Un passage déjà en cours n'est
 * pas doublé, son compte rendu sert aussi au second appelant : deux passages simultanés liraient les mêmes états et
 * enverraient deux fois le même courriel.
 */
export function superviserModeles(deps: SupervisionDeps): Promise<RapportSupervision> {
  memoire.passageSupervision ??= passage(deps).finally(() => {
    memoire.passageSupervision = undefined;
  });
  return memoire.passageSupervision;
}

async function passage(deps: SupervisionDeps): Promise<RapportSupervision> {
  const now = (deps.now ?? (() => new Date()))();
  const fiches = await deps.db.catalogEntry.findMany({ where: { visible: true }, orderBy: { modelName: "asc" } });
  const precedents = new Map((await deps.db.modelHealth.findMany()).map(({ modelName, ...etat }) => [modelName, etat]));
  const passerelle = await modelesDeLaPasserelle(deps.litellm);

  const rapport: RapportSupervision = { sondes: 0, enPanne: [], degrades: [], nonSupervises: [], alertesPanne: [], retablissements: [] };
  const pannes: (ModeleEnEchec & { displayName: string })[] = [];
  const retablis: { modelName: string; displayName: string; since: Date }[] = [];

  await Promise.all(
    fiches.map(async (fiche) => {
      const sonde = await sonder(deps.litellm, passerelle, fiche.modelName, precedents.has(fiche.modelName));
      if (sonde === null) {
        rapport.nonSupervises.push(fiche.modelName);
        return;
      }
      rapport.sondes++;
      const precedent = precedents.get(fiche.modelName) ?? null;
      const { etat, alerte } = etatApresSonde(precedent, sonde, now);
      await deps.db.modelHealth.upsert({ where: { modelName: fiche.modelName }, create: { modelName: fiche.modelName, ...etat }, update: etat });
      const statut = statutDeLEtat(etat);
      const echec: ModeleEnEchec = { modelName: fiche.modelName, error: sonde.error, errorCode: sonde.errorCode };
      if (statut === "en_panne") rapport.enPanne.push(echec);
      if (statut === "degrade") rapport.degrades.push(echec);
      if (alerte === "panne") pannes.push({ ...echec, displayName: fiche.displayNameFr });
      if (alerte === "retablissement" && precedent) retablis.push({ modelName: fiche.modelName, displayName: fiche.displayNameFr, since: precedent.since });
    }),
  );
  await deps.db.modelHealth.deleteMany({ where: { modelName: { notIn: fiches.map((f) => f.modelName) } } });

  const parNom = (a: { modelName: string }, b: { modelName: string }) => a.modelName.localeCompare(b.modelName);
  rapport.enPanne.sort(parNom);
  rapport.degrades.sort(parNom);
  rapport.nonSupervises.sort();
  let alertes = pannes.sort(parNom);
  if (alertes.length > 0 && !(await notifyModelsDown(deps, alertes, deps.intervalleMinutes ?? null))) {
    // Courriel non parti : l'alerte n'est pas comptée comme envoyée, elle repartira au passage suivant.
    await deps.db.modelHealth.updateMany({ where: { modelName: { in: alertes.map((p) => p.modelName) } }, data: { alertedAt: null } });
    alertes = [];
  }
  if (retablis.length > 0) await notifyModelsRestored(deps, retablis.sort(parNom));
  rapport.alertesPanne = alertes.map((p) => p.modelName);
  rapport.retablissements = retablis.map((r) => r.modelName);
  return rapport;
}

/** Modèles déclarés dans LiteLLM, par nom ; si LiteLLM ne répond pas, le détail de l'erreur, qui met chaque modèle en panne. */
async function modelesDeLaPasserelle(litellm: LiteLLMClient): Promise<Map<string, LiteLLMModel> | { injoignable: string | null }> {
  try {
    return new Map((await litellm.listModels()).map((m) => [m.modelName, m]));
  } catch (e) {
    return { injoignable: e instanceof Error ? e.message : null };
  }
}

/**
 * Sonde d'un modèle visible ; null pour un modèle qui n'est pas sondé : un modèle d'images, ou, LiteLLM injoignable, un
 * modèle jamais sondé, dont le type n'est alors pas connu (un modèle d'images mis en panne ne serait jamais rétabli).
 */
async function sonder(
  litellm: LiteLLMClient,
  passerelle: Map<string, LiteLLMModel> | { injoignable: string | null },
  modelName: string,
  dejaSonde: boolean,
): Promise<ProbeResult | null> {
  if (!(passerelle instanceof Map)) return dejaSonde ? { status: null, latencyMs: 0, error: passerelle.injoignable, errorCode: "passerelle_injoignable" } : null;
  const modele = passerelle.get(modelName);
  // Visible au catalogue mais absent de LiteLLM : les collaborateurs le voient sans pouvoir l'appeler.
  if (!modele) return { status: null, latencyMs: 0, error: null, errorCode: "absent_de_la_passerelle" };
  if (modele.apiKind === "image") return null;
  return litellm.probeModel(modelName, modele.apiKind);
}

/**
 * État d'un modèle visible, tel que l'affiche l'onglet « Supervision » : dégradé dès un échec, en panne à partir de
 * SEUIL_ALERTE échecs consécutifs, quand l'alerte part aux admins.
 */
export type StatutModele = "ok" | "degrade" | "en_panne" | "en_attente" | "non_supervise";

/** Statut d'un modèle sondé, d'après son état enregistré. */
export function statutDeLEtat(etat: Pick<EtatModele, "healthy" | "failures">): "ok" | "degrade" | "en_panne" {
  if (etat.healthy) return "ok";
  return etat.failures >= SEUIL_ALERTE ? "en_panne" : "degrade";
}

export interface EtatModeleVue {
  modelName: string;
  displayName: string;
  dataLevel: DataLevel;
  apiKind: ApiKind | null;
  statut: StatutModele;
  /** Depuis quand le modèle répond, ou ne répond plus ; null sans sonde. */
  since: Date | null;
  checkedAt: Date | null;
  latencyMs: number | null;
  httpStatus: number | null;
  error: string | null;
  errorCode: CodeErreurSonde | null;
  /** Alerte de panne envoyée aux admins, et sa date ; null sinon. */
  alertedAt: Date | null;
}

/**
 * Onglet « Supervision » (admins seulement) : chaque modèle visible du catalogue avec son dernier état connu, les modèles
 * en panne d'abord, puis les dégradés, puis par nom affiché dans la langue de l'admin (repli sur le français).
 */
export async function etatDesModeles(deps: { db: Db; litellm: LiteLLMClient }, user: SessionUser, langue: Langue): Promise<EtatModeleVue[]> {
  requireAdmin(user);
  return lireEtats(deps, langue);
}

/** Dernier état connu de chaque modèle visible du catalogue, les modèles en panne d'abord. */
async function lireEtats(deps: { db: Db; litellm: LiteLLMClient }, langue: Langue): Promise<EtatModeleVue[]> {
  const [fiches, etats, passerelle] = await Promise.all([
    deps.db.catalogEntry.findMany({ where: { visible: true } }),
    deps.db.modelHealth.findMany(),
    modelesDeLaPasserelle(deps.litellm),
  ]);
  const parNom = new Map(etats.map((e) => [e.modelName, e]));
  const ORDRE: StatutModele[] = ["en_panne", "degrade", "en_attente", "ok", "non_supervise"];
  return fiches
    .map((fiche): EtatModeleVue => {
      const apiKind = passerelle instanceof Map ? (passerelle.get(fiche.modelName)?.apiKind ?? null) : null;
      const etat = parNom.get(fiche.modelName);
      const displayName = (langue === "en" && fiche.displayNameEn) || fiche.displayNameFr;
      const statut: StatutModele = apiKind === "image" ? "non_supervise" : !etat ? "en_attente" : statutDeLEtat(etat);
      return {
        modelName: fiche.modelName,
        displayName,
        dataLevel: fiche.dataLevel,
        apiKind,
        statut,
        since: etat?.since ?? null,
        checkedAt: etat?.checkedAt ?? null,
        latencyMs: etat?.latencyMs ?? null,
        httpStatus: etat?.httpStatus ?? null,
        error: etat?.error ?? null,
        errorCode: (etat?.errorCode ?? null) as CodeErreurSonde | null,
        alertedAt: etat?.alertedAt ?? null,
      };
    })
    .sort((a, b) => ORDRE.indexOf(a.statut) - ORDRE.indexOf(b.statut) || a.displayName.localeCompare(b.displayName, langue));
}

/**
 * État d'un modèle tel que le voient les collaborateurs : perturbé dès un échec, en incident quand les admins sont
 * prévenus ; non vérifié avant la première sonde, non surveillé pour un modèle d'images.
 */
export type StatutService = "operationnel" | "perturbe" | "incident" | "non_verifie" | "non_surveille";

const STATUT_SERVICE: Record<StatutModele, StatutService> = {
  ok: "operationnel",
  degrade: "perturbe",
  en_panne: "incident",
  en_attente: "non_verifie",
  non_supervise: "non_surveille",
};

/** Modèle du tableau « État des services » : ni erreur, ni code HTTP, ni fournisseur, qui exposeraient le routage interne. */
export interface EtatServiceVue {
  modelName: string;
  displayName: string;
  dataLevel: DataLevel;
  statut: StatutService;
  /** Début de la perturbation ou de l'incident ; null pour les autres états. */
  since: Date | null;
  checkedAt: Date | null;
}

/**
 * Onglet « État des services » (ticket #142), ouvert à tout collaborateur connecté : l'état actuel de chaque modèle visible
 * du catalogue, les incidents d'abord, puis les perturbations, dans la langue du collaborateur.
 */
export async function etatDesServices(deps: { db: Db; litellm: LiteLLMClient }, langue: Langue): Promise<EtatServiceVue[]> {
  return (await lireEtats(deps, langue)).map((m) => {
    const statut = STATUT_SERVICE[m.statut];
    return {
      modelName: m.modelName,
      displayName: m.displayName,
      dataLevel: m.dataLevel,
      statut,
      since: statut === "perturbe" || statut === "incident" ? m.since : null,
      checkedAt: m.checkedAt,
    };
  });
}

/** Bouton « Sonder maintenant » de l'onglet « Supervision » : un passage immédiat, réservé aux admins. */
export async function sonderMaintenant(deps: SupervisionDeps, user: SessionUser): Promise<RapportSupervision> {
  requireAdmin(user);
  return superviserModeles(deps);
}
