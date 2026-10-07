import type { ModelHealth } from "@/generated/prisma/client";
import type { SessionUser } from "@/lib/auth-user";
import type { Db } from "@/lib/db";
import type { ApiKind, LiteLLMClient, LiteLLMModel, ProbeResult } from "@/lib/litellm/client";
import type { Langue } from "@/lib/langue";
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

/** Erreur d'un modèle visible au catalogue mais absent de LiteLLM : les collaborateurs le voient sans pouvoir l'appeler. */
export const ABSENT_DE_LA_PASSERELLE = "modèle absent de la passerelle (non déclaré dans LiteLLM)";

/** Alerte qu'appelle une sonde : la panne, après SEUIL_ALERTE échecs, ou le rétablissement d'un modèle annoncé en panne. */
export type Alerte = "panne" | "retablissement" | null;

/** État enregistré d'un modèle, sans son nom. */
export type EtatModele = Omit<ModelHealth, "modelName">;

/**
 * Règle pure : état d'un modèle après une sonde, et l'alerte qu'elle appelle. `since` est la date du dernier changement
 * d'état ; une seule alerte de panne par panne, et un rétablissement n'est annoncé que si la panne l'a été.
 */
export function etatApresSonde(precedent: EtatModele | null, sonde: ProbeResult, now: Date): { etat: EtatModele; alerte: Alerte } {
  const repond = sonde.error === null;
  const mesure = { checkedAt: now, latencyMs: sonde.latencyMs, httpStatus: sonde.status, error: sonde.error };
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

/** Compte rendu d'un passage de la supervision. */
export interface RapportSupervision {
  sondes: number;
  /** Modèles en panne : au moins SEUIL_ALERTE échecs consécutifs, admins prévenus. */
  enPanne: { modelName: string; error: string | null }[];
  /** Modèles dégradés : en échec depuis moins de SEUIL_ALERTE sondes, sans alerte encore. */
  degrades: { modelName: string; error: string | null }[];
  nonSupervises: string[];
  alertesPanne: string[];
  retablissements: string[];
}

/**
 * Un passage de la supervision : sonde de chaque modèle visible du catalogue, en parallèle, mise à jour de son état, puis
 * un seul courriel aux admins pour les pannes nouvelles et un pour les rétablissements (une panne d'OpenRouter touche
 * d'un coup tous ses modèles). Un modèle masqué ou retiré du catalogue n'est plus suivi.
 */
export async function superviserModeles(deps: SupervisionDeps): Promise<RapportSupervision> {
  const now = (deps.now ?? (() => new Date()))();
  const fiches = await deps.db.catalogEntry.findMany({ where: { visible: true }, orderBy: { modelName: "asc" } });
  const precedents = new Map((await deps.db.modelHealth.findMany()).map(({ modelName, ...etat }) => [modelName, etat]));
  const passerelle = await modelesDeLaPasserelle(deps.litellm);

  const rapport: RapportSupervision = { sondes: 0, enPanne: [], degrades: [], nonSupervises: [], alertesPanne: [], retablissements: [] };
  const pannes: { modelName: string; displayName: string; error: string | null }[] = [];
  const retablis: { modelName: string; displayName: string; since: Date }[] = [];

  await Promise.all(
    fiches.map(async (fiche) => {
      const sonde = await sonder(deps.litellm, passerelle, fiche.modelName);
      if (sonde === null) {
        rapport.nonSupervises.push(fiche.modelName);
        return;
      }
      rapport.sondes++;
      const precedent = precedents.get(fiche.modelName) ?? null;
      const { etat, alerte } = etatApresSonde(precedent, sonde, now);
      await deps.db.modelHealth.upsert({ where: { modelName: fiche.modelName }, create: { modelName: fiche.modelName, ...etat }, update: etat });
      const statut = statutDeLEtat(etat);
      if (statut === "en_panne") rapport.enPanne.push({ modelName: fiche.modelName, error: etat.error });
      if (statut === "degrade") rapport.degrades.push({ modelName: fiche.modelName, error: etat.error });
      if (alerte === "panne") pannes.push({ modelName: fiche.modelName, displayName: fiche.displayNameFr, error: etat.error });
      if (alerte === "retablissement" && precedent) retablis.push({ modelName: fiche.modelName, displayName: fiche.displayNameFr, since: precedent.since });
    }),
  );
  await deps.db.modelHealth.deleteMany({ where: { modelName: { notIn: fiches.map((f) => f.modelName) } } });

  const parNom = (a: { modelName: string }, b: { modelName: string }) => a.modelName.localeCompare(b.modelName);
  rapport.enPanne.sort(parNom);
  rapport.degrades.sort(parNom);
  rapport.nonSupervises.sort();
  if (pannes.length > 0) await notifyModelsDown(deps, pannes.sort(parNom), deps.intervalleMinutes ?? null);
  if (retablis.length > 0) await notifyModelsRestored(deps, retablis.sort(parNom));
  rapport.alertesPanne = pannes.map((p) => p.modelName);
  rapport.retablissements = retablis.map((r) => r.modelName);
  return rapport;
}

/** Modèles déclarés dans LiteLLM, par nom ; si LiteLLM ne répond pas, l'erreur, qui met chaque modèle en panne. */
async function modelesDeLaPasserelle(litellm: LiteLLMClient): Promise<Map<string, LiteLLMModel> | { error: string }> {
  try {
    return new Map((await litellm.listModels()).map((m) => [m.modelName, m]));
  } catch (e) {
    return { error: `passerelle injoignable (${e instanceof Error ? e.message : "erreur inconnue"})` };
  }
}

/** Sonde d'un modèle visible ; null pour un modèle d'images, qui n'est pas sondé. */
async function sonder(litellm: LiteLLMClient, passerelle: Map<string, LiteLLMModel> | { error: string }, modelName: string): Promise<ProbeResult | null> {
  if (!(passerelle instanceof Map)) return { status: null, latencyMs: 0, error: passerelle.error };
  const modele = passerelle.get(modelName);
  if (!modele) return { status: null, latencyMs: 0, error: ABSENT_DE_LA_PASSERELLE };
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
  apiKind: ApiKind | null;
  statut: StatutModele;
  /** Depuis quand le modèle répond, ou ne répond plus ; null sans sonde. */
  since: Date | null;
  checkedAt: Date | null;
  latencyMs: number | null;
  httpStatus: number | null;
  error: string | null;
  /** Alerte de panne envoyée aux admins, et sa date ; null sinon. */
  alertedAt: Date | null;
}

/**
 * Onglet « Supervision » (admins seulement) : chaque modèle visible du catalogue avec son dernier état connu, les modèles
 * en panne d'abord, puis les dégradés, puis par nom affiché dans la langue de l'admin (repli sur le français).
 */
export async function etatDesModeles(deps: { db: Db; litellm: LiteLLMClient }, user: SessionUser, langue: Langue): Promise<EtatModeleVue[]> {
  requireAdmin(user);
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
        apiKind,
        statut,
        since: etat?.since ?? null,
        checkedAt: etat?.checkedAt ?? null,
        latencyMs: etat?.latencyMs ?? null,
        httpStatus: etat?.httpStatus ?? null,
        error: etat?.error ?? null,
        alertedAt: etat?.alertedAt ?? null,
      };
    })
    .sort((a, b) => ORDRE.indexOf(a.statut) - ORDRE.indexOf(b.statut) || a.displayName.localeCompare(b.displayName, langue));
}

/** Bouton « Sonder maintenant » de l'onglet « Supervision » : un passage immédiat, réservé aux admins. */
export async function sonderMaintenant(deps: SupervisionDeps, user: SessionUser): Promise<RapportSupervision> {
  requireAdmin(user);
  return superviserModeles(deps);
}
