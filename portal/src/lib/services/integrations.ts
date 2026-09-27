import { Prisma, type IntegrationKey, type IntegrationScope } from "@/generated/prisma/client";
import type { SessionUser } from "@/lib/auth-user";
import type { Db } from "@/lib/db";
import { PortalError } from "@/lib/errors";
import { estAdresseOuPlage } from "@/lib/integrations/adresses";
import { type Algorithme, empreinte, lireClePublique } from "@/lib/integrations/cles-publiques";
import { requireAdmin } from "@/lib/rbac";
import { recordAudit } from "./audit";
import { type ChampIntegration, type NotificationDeps, notifyIntegrationChange } from "./notifications";

/**
 * Registre des intégrations (spécification #71, ADR 0003) : les applications tierces qu'un admin autorise à agir pour un
 * collaborateur par l'API du portail. Réservé aux admins ; chaque changement est inscrit au journal d'audit et annoncé
 * par courriel à tous les admins.
 */
export interface IntegrationDeps extends NotificationDeps {
  db: Db;
}

/** Périmètres d'une intégration, tels que les nomment l'API et l'onglet : lecture, demandes, clés. */
export const PERIMETRES = ["lecture", "demandes", "cles"] as const;
export type Perimetre = (typeof PERIMETRES)[number];

const EN_BASE: Record<Perimetre, IntegrationScope> = { lecture: "LECTURE", demandes: "DEMANDES", cles: "CLES" };
const perimetre = (scope: IntegrationScope) => PERIMETRES.find((p) => EN_BASE[p] === scope) as Perimetre;

/** Identifiant d'une intégration : de 2 à 40 caractères, minuscules, chiffres et tirets isolés (« team-manager »). */
const IDENTIFIANT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Identifiant d'une clé (`kid`) : de 1 à 64 lettres, chiffres, points, tirets ou soulignés. */
const KID = /^[A-Za-z0-9._-]{1,64}$/;
const NOM_MAXIMAL = 100;
const PLAFOND_MAXIMAL = 10_000;

/** Réglages d'une intégration que l'admin saisit et modifie ; l'identifiant, lui, ne change jamais. */
export interface IntegrationSettings {
  name: string;
  scopes: readonly string[];
  ipRanges: readonly string[];
  rateLimitPerMinute: number;
}

export interface IntegrationInput extends IntegrationSettings {
  id: string;
}

export interface IntegrationKeyInput {
  kid: string;
  algorithm: string;
  publicKeyPem: string;
}

/** Clé publique telle que la montre l'onglet : son empreinte, jamais la clé elle-même. */
export interface IntegrationKeyView {
  kid: string;
  algorithm: Algorithme;
  fingerprint: string;
  createdAt: Date;
  createdBy: string;
  removedAt: Date | null;
  removedBy: string | null;
}

export interface IntegrationView {
  id: string;
  name: string;
  scopes: Perimetre[];
  ipRanges: string[];
  rateLimitPerMinute: number;
  active: boolean;
  createdAt: Date;
  createdBy: string;
  updatedAt: Date;
  /** Clés en service, de la plus ancienne à la plus récente. */
  keys: IntegrationKeyView[];
  /** Clés retirées : elles ne vérifient plus aucun jeton, et leur `kid` ne resert pas. */
  removedKeys: IntegrationKeyView[];
}

/**
 * Intégration telle que la contrôle chaque appel de l'API : état, périmètres, adresses, plafond et clés en service. Lue
 * sans contrôle d'admin (c'est le portail qui la lit), à chaque appel : une désactivation prend effet aussitôt.
 */
export interface IntegrationAppelante {
  id: string;
  active: boolean;
  scopes: Perimetre[];
  ipRanges: string[];
  rateLimitPerMinute: number;
  keys: { kid: string; algorithm: Algorithme; publicKeyPem: string }[];
}

export async function lireIntegrationAppelante(db: Db, id: string): Promise<IntegrationAppelante | null> {
  const i = await db.integration.findUnique({ where: { id }, include: { keys: { where: { removedAt: null } } } });
  if (!i) return null;
  return {
    id: i.id,
    active: i.active,
    scopes: i.scopes.map(perimetre),
    ipRanges: i.ipRanges,
    rateLimitPerMinute: i.rateLimitPerMinute,
    keys: i.keys.map((k) => ({ kid: k.kid, algorithm: k.algorithm as Algorithme, publicKeyPem: k.publicKeyPem })),
  };
}

/** Intégrations, les actives d'abord, puis par nom. */
export async function listIntegrations(deps: IntegrationDeps, actor: SessionUser): Promise<IntegrationView[]> {
  requireAdmin(actor);
  const integrations = await deps.db.integration.findMany({
    include: { keys: { orderBy: [{ createdAt: "asc" }, { kid: "asc" }] } },
    orderBy: [{ active: "desc" }, { name: "asc" }],
  });
  return integrations.map((i) => ({
    id: i.id,
    name: i.name,
    scopes: i.scopes.map(perimetre),
    ipRanges: i.ipRanges,
    rateLimitPerMinute: i.rateLimitPerMinute,
    active: i.active,
    createdAt: i.createdAt,
    createdBy: i.createdBy,
    updatedAt: i.updatedAt,
    keys: i.keys.filter((k) => !k.removedAt).map(vueCle),
    removedKeys: i.keys.filter((k) => k.removedAt).map(vueCle),
  }));
}

const vueCle = (k: IntegrationKey): IntegrationKeyView => ({
  kid: k.kid,
  algorithm: k.algorithm as Algorithme,
  fingerprint: empreinte(k.publicKeyPem),
  createdAt: k.createdAt,
  createdBy: k.createdBy,
  removedAt: k.removedAt,
  removedBy: k.removedBy,
});

/** Déclare une intégration, désactivée jusqu'à ce qu'un admin l'active après la recette. Rend son identifiant. */
export async function createIntegration(deps: IntegrationDeps, actor: SessionUser, input: IntegrationInput): Promise<string> {
  requireAdmin(actor);
  const id = input.id.trim();
  if (id.length < 2 || id.length > 40 || !IDENTIFIANT.test(id)) throw invalide("identifiant");
  const reglages = controlerReglages(input);
  const existante = new PortalError("integration_existante", `L'identifiant ${id} est déjà pris par une autre intégration.`, { id });
  if (await deps.db.integration.findUnique({ where: { id } })) throw existante;
  await siUnique(deps.db.integration.create({ data: { id, ...enBase(reglages), createdBy: actor.uid } }), existante);
  await recordAudit(deps.db, { actorUid: actor.uid, action: "INTEGRATION_CREATED", targetId: id, details: detailsAudit(reglages) });
  await notifyIntegrationChange(deps, {
    type: "creee",
    id,
    nom: reglages.name,
    auteur: actor,
    perimetres: reglages.scopes,
    adresses: reglages.ipRanges,
    plafond: reglages.rateLimitPerMinute,
  });
  return id;
}

/** Modifie le nom, le périmètre, les adresses et le plafond d'une intégration ; sans changement, rien n'est inscrit ni envoyé. */
export async function updateIntegration(deps: IntegrationDeps, actor: SessionUser, id: string, input: IntegrationSettings): Promise<void> {
  requireAdmin(actor);
  const avant = await trouver(deps, id);
  const apres = controlerReglages(input);
  const valeurs = (r: Reglages) => ({ nom: r.name, perimetres: r.scopes, adresses: r.ipRanges, plafond: r.rateLimitPerMinute });
  const [anciennes, nouvelles] = [valeurs({ ...avant, scopes: avant.scopes.map(perimetre) }), valeurs(apres)];
  const modifications = (Object.keys(nouvelles) as ChampIntegration[])
    .filter((champ) => String(anciennes[champ]) !== String(nouvelles[champ]))
    .map((champ) => ({ champ, avant: anciennes[champ], apres: nouvelles[champ] }));
  if (modifications.length === 0) return;
  await deps.db.integration.update({ where: { id }, data: enBase(apres) });
  await recordAudit(deps.db, {
    actorUid: actor.uid,
    action: "INTEGRATION_UPDATED",
    targetId: id,
    details: Object.fromEntries(modifications.flatMap((m) => [[m.champ, enTexte(m.apres)], [`${m.champ}Avant`, enTexte(m.avant)]])),
  });
  await notifyIntegrationChange(deps, { type: "modifiee", id, nom: apres.name, auteur: actor, modifications });
}

/** Enregistre une clé publique de l'intégration, contrôlée pour son algorithme ; son `kid` est unique pour l'intégration. */
export async function addIntegrationKey(deps: IntegrationDeps, actor: SessionUser, id: string, input: IntegrationKeyInput): Promise<void> {
  requireAdmin(actor);
  const integration = await trouver(deps, id);
  const kid = input.kid.trim();
  if (!KID.test(kid)) throw refusCle("kid");
  const cle = lireClePublique(input.algorithm, input.publicKeyPem.trim());
  if (!cle.ok) throw refusCle(cle.raison);
  const pris = new PortalError("kid_existant", `L'identifiant de clé ${kid} est déjà utilisé par l'intégration ${id}.`, { kid });
  if (await deps.db.integrationKey.findUnique({ where: { integrationId_kid: { integrationId: id, kid } } })) throw pris;
  await siUnique(deps.db.integrationKey.create({ data: { integrationId: id, kid, algorithm: input.algorithm, publicKeyPem: cle.publicKeyPem, createdBy: actor.uid } }), pris);
  const details = { kid, algorithme: input.algorithm, empreinte: empreinte(cle.publicKeyPem) };
  await recordAudit(deps.db, { actorUid: actor.uid, action: "INTEGRATION_KEY_ADDED", targetId: id, details });
  await notifyIntegrationChange(deps, { type: "cleAjoutee", id, nom: integration.name, auteur: actor, ...details });
}

/** Retire une clé publique : les jetons qu'elle signe sont refusés ; elle reste inscrite, et son `kid` ne resert pas. */
export async function removeIntegrationKey(deps: IntegrationDeps, actor: SessionUser, id: string, kid: string): Promise<void> {
  requireAdmin(actor);
  const integration = await trouver(deps, id);
  const introuvable = new PortalError("introuvable", `Clé ${kid} introuvable ou déjà retirée.`, { objet: "cle_integration" });
  const cle = await deps.db.integrationKey.findUnique({ where: { integrationId_kid: { integrationId: id, kid } } });
  if (!cle || cle.removedAt) throw introuvable;
  const { count } = await deps.db.integrationKey.updateMany({ where: { id: cle.id, removedAt: null }, data: { removedAt: new Date(), removedBy: actor.uid } });
  if (count !== 1) throw introuvable;
  const details = { kid, algorithme: cle.algorithm, empreinte: empreinte(cle.publicKeyPem) };
  await recordAudit(deps.db, { actorUid: actor.uid, action: "INTEGRATION_KEY_REMOVED", targetId: id, details });
  await notifyIntegrationChange(deps, { type: "cleRetiree", id, nom: integration.name, auteur: actor, ...details });
}

/** Active ou désactive une intégration ; une intégration ne se supprime jamais. Sans changement, rien n'est inscrit ni envoyé. */
export async function setIntegrationActive(deps: IntegrationDeps, actor: SessionUser, id: string, active: boolean): Promise<void> {
  requireAdmin(actor);
  const integration = await trouver(deps, id);
  const { count } = await deps.db.integration.updateMany({ where: { id, active: !active }, data: { active } });
  if (count === 0) return;
  await recordAudit(deps.db, { actorUid: actor.uid, action: active ? "INTEGRATION_ACTIVATED" : "INTEGRATION_DEACTIVATED", targetId: id, details: {} });
  const qui = { id, nom: integration.name, auteur: actor };
  await notifyIntegrationChange(deps, active ? { type: "activee", ...qui, perimetres: integration.scopes.map(perimetre) } : { type: "desactivee", ...qui });
}

/** Réglages contrôlés et mis en forme : nom sans espaces autour, périmètres dans l'ordre, adresses sans doublon. */
type Reglages = { name: string; scopes: Perimetre[]; ipRanges: string[]; rateLimitPerMinute: number };

function controlerReglages(input: IntegrationSettings): Reglages {
  const name = input.name.trim();
  if (!name || name.length > NOM_MAXIMAL) throw invalide("nom");
  const inconnu = input.scopes.find((p) => !(PERIMETRES as readonly string[]).includes(p));
  if (inconnu !== undefined) throw invalide("perimetres", inconnu);
  const ipRanges = [...new Set(input.ipRanges.map((a) => a.trim()).filter(Boolean))];
  const fausse = ipRanges.find((a) => !estAdresseOuPlage(a));
  if (fausse !== undefined) throw invalide("adresses", fausse);
  const plafond = input.rateLimitPerMinute;
  if (!Number.isInteger(plafond) || plafond < 1 || plafond > PLAFOND_MAXIMAL) throw invalide("plafond");
  return { name, scopes: PERIMETRES.filter((p) => input.scopes.includes(p)), ipRanges, rateLimitPerMinute: plafond };
}

const enBase = (r: Reglages) => ({ ...r, scopes: r.scopes.map((p) => EN_BASE[p]) });

const enTexte = (valeur: string | number | string[]) => (Array.isArray(valeur) ? valeur.join(", ") : valeur);

const detailsAudit = (r: Reglages) => ({ nom: r.name, perimetres: enTexte(r.scopes), adresses: enTexte(r.ipRanges), plafond: r.rateLimitPerMinute });

async function trouver(deps: IntegrationDeps, id: string) {
  const integration = await deps.db.integration.findUnique({ where: { id } });
  if (!integration) throw new PortalError("introuvable", `Intégration ${id} introuvable.`, { objet: "integration" });
  return integration;
}

/** Enregistrement soumis à une contrainte d'unicité : deux envois simultanés du même formulaire lèvent l'erreur métier. */
async function siUnique<T>(enregistrement: Promise<T>, erreur: PortalError): Promise<T> {
  try {
    return await enregistrement;
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") throw erreur;
    throw e;
  }
}

function invalide(champ: "identifiant" | ChampIntegration, valeur?: string): PortalError {
  return new PortalError("integration_invalide", `Intégration : ${champ} invalide.`, valeur === undefined ? { champ } : { champ, valeur });
}

function refusCle(raison: string): PortalError {
  return new PortalError("cle_publique_invalide", `Clé publique refusée : ${raison}.`, { raison });
}
