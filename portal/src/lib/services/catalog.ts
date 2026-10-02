import { z } from "zod";
import type { SessionUser } from "@/lib/auth-user";
import type { Db } from "@/lib/db";
import type { ApiKind, Capability, ExecutionRegion, LiteLLMClient, LiteLLMModel } from "@/lib/litellm/client";
import { PortalError } from "@/lib/errors";
import type { Langue } from "@/lib/langue";
import { DATA_LEVELS, type DataLevel, modelAcceptsLevel } from "@/lib/policy";
import { UseCase } from "@/lib/use-cases";
import { requireAdmin } from "@/lib/rbac";

const texte = z.string().trim().min(1);
/** Texte facultatif : une valeur vide vaut absence (l'affichage retombe alors sur le français). */
const texteFacultatif = z
  .string()
  .trim()
  .nullish()
  .transform((valeur) => valeur || null);

/** Fiche d'un modèle saisie par l'admin (F-50, ticket #6) : français obligatoire sauf les limites, anglais facultatif. */
export const catalogEntryInputSchema = z.object({
  modelName: z.string().min(1),
  displayNameFr: texte,
  displayNameEn: texteFacultatif,
  shortDescriptionFr: texte,
  shortDescriptionEn: texteFacultatif,
  longDescriptionFr: texte,
  longDescriptionEn: texteFacultatif,
  limitationsFr: texteFacultatif,
  limitationsEn: texteFacultatif,
  useCases: z.array(z.enum(UseCase)),
  recommendedFor: z.array(z.enum(UseCase)),
  dataLevel: z.enum(DATA_LEVELS),
  visible: z.boolean(),
});

export type CatalogEntryInput = z.input<typeof catalogEntryInputSchema>;

/** Modèle tel que présenté aux utilisateurs (F-11). Prix en euros par million de jetons. */
export interface CatalogItem {
  modelName: string;
  displayName: string;
  description: string;
  useCases: UseCase[];
  /** Éditeur et zone d'exécution, déclarés par la passerelle. Le fournisseur n'est montré qu'aux admins. */
  publisher: string | null;
  executionRegion: ExecutionRegion | null;
  dataLevel: DataLevel;
  inputPricePerMillion: number;
  outputPricePerMillion: number;
  maxInputTokens: number | null;
}

interface CatalogDeps {
  db: Db;
  litellm: LiteLLMClient;
}

/**
 * F-10 : modèles de LiteLLM enrichis et rendus visibles par un admin, dans la langue demandée (repli sur le
 * français), par ordre de nom affiché.
 */
export async function listCatalog(deps: CatalogDeps, language: Langue = "fr"): Promise<CatalogItem[]> {
  const text = inLanguage(language);
  return (await visibleModels(deps)).map(({ entry, model, inputPricePerMillion, outputPricePerMillion }) => ({
    modelName: entry.modelName,
    displayName: text(entry.displayNameFr, entry.displayNameEn),
    description: text(entry.shortDescriptionFr, entry.shortDescriptionEn),
    useCases: entry.useCases,
    publisher: model.publisher,
    executionRegion: model.executionRegion,
    dataLevel: entry.dataLevel,
    inputPricePerMillion,
    outputPricePerMillion,
    maxInputTokens: model.maxInputTokens,
  })).sort((a, b) => a.displayName.localeCompare(b.displayName, language));
}

/** Nom affiché de chaque modèle qui a une fiche, visible ou non, dans la langue demandée (repli sur le français). */
export async function displayNames(deps: { db: Db }, language: Langue): Promise<Map<string, string>> {
  const text = inLanguage(language);
  return new Map((await deps.db.catalogEntry.findMany()).map((entry) => [entry.modelName, text(entry.displayNameFr, entry.displayNameEn)]));
}

/** Modèle recommandé pour un cas d'usage, avec son niveau maximal. */
export interface RecommendedModel {
  modelName: string;
  displayName: string;
  dataLevel: DataLevel;
}

/**
 * Modèles visibles que l'admin recommande pour un cas d'usage, du niveau le moins confidentiel au plus confidentiel
 * (Expérimental en dernier), puis par nom affiché, dans la langue demandée (repli sur le français).
 */
export async function recommendedModels(deps: CatalogDeps, useCase: UseCase, language: Langue): Promise<RecommendedModel[]> {
  const text = inLanguage(language);
  return (await visibleModels(deps))
    .filter(({ entry }) => entry.recommendedFor.includes(useCase))
    .map(({ entry }) => ({ modelName: entry.modelName, displayName: text(entry.displayNameFr, entry.displayNameEn), dataLevel: entry.dataLevel }))
    .sort((a, b) => DATA_LEVELS.indexOf(a.dataLevel) - DATA_LEVELS.indexOf(b.dataLevel) || a.displayName.localeCompare(b.displayName, language));
}

/** Fiche visible et modèle LiteLLM correspondant, avec ses prix en euros par million de jetons. */
type VisibleModel = Awaited<ReturnType<typeof visibleModels>>[number];

/** Fiches visibles dont le modèle est déclaré dans LiteLLM avec ses prix, en euros par million de jetons. */
async function visibleModels(deps: CatalogDeps) {
  const [models, entries] = await Promise.all([deps.litellm.listModels(), deps.db.catalogEntry.findMany({ where: { visible: true } })]);
  return entries.flatMap((entry) => {
    const model = models.find((m) => m.modelName === entry.modelName);
    if (!model || model.inputCostPerToken === null || model.outputCostPerToken === null) return [];
    return [{ entry, model, inputPricePerMillion: perMillion(model.inputCostPerToken), outputPricePerMillion: perMillion(model.outputCostPerToken) }];
  });
}

/** Carte d'un modèle sur la page d'un niveau (ticket #7), dans la langue du salarié. Prix en euros par million de jetons. */
export interface LevelModel {
  modelName: string;
  displayName: string;
  shortDescription: string;
  publisher: string | null;
  executionRegion: ExecutionRegion | null;
  capabilities: Capability[];
  inputPricePerMillion: number;
  outputPricePerMillion: number;
  useCases: UseCase[];
  /** Niveau maximal du modèle quand il dépasse celui de la page (badge « accepte jusqu'à N3 »), sinon null. */
  acceptsUpTo: DataLevel | null;
  /** Cas d'usage pour lesquels l'admin recommande le modèle, sur la seule page de son niveau maximal. */
  recommendedFor: UseCase[];
  priceTier: PriceTier;
  /** Prix indicatif d'une image, en euros, pour un modèle d'images ; null pour les autres modèles. */
  pricePerImage: number | null;
  /**
   * Contexte arrondi au millier de jetons et son équivalent en pages ; null si la passerelle ne le déclare pas,
   * ou pour un modèle d'images, dont le contexte en jetons ne dit rien d'utile au salarié.
   */
  context: { tokens: number; pages: number } | null;
}

/** Hypothèse de conversion, indiquée en infobulle : une page de texte en français compte environ 750 jetons. */
export const TOKENS_PER_PAGE = 750;

function context(maxInputTokens: number | null): LevelModel["context"] {
  if (maxInputTokens === null) return null;
  return { tokens: Math.round(maxInputTokens / 1000) * 1000, pages: approximately(maxInputTokens / TOKENS_PER_PAGE) };
}

/** Valeur annoncée « environ » : entière sous 100, arrondie à deux chiffres significatifs au-delà (1 398 donne 1 400). */
function approximately(value: number): number {
  if (value < 100) return Math.round(value);
  const step = 10 ** (Math.floor(Math.log10(value)) - 1);
  return Math.round(value / step) * step;
}

/** Repère de prix d'un modèle, calculé sur son prix mixte. */
export type PriceTier = "€" | "€€" | "€€€";

/** Seuils fixes, indépendants du contenu du catalogue : € sous 0,30 €, €€ jusqu'à 1 € exclu, €€€ au-delà. */
function priceTier(blended: number): PriceTier {
  return blended < 0.3 ? "€" : blended < 1 ? "€€" : "€€€";
}

/** Critères de la page d'un niveau (ticket #8). */
export interface LevelCriteria {
  /** Partie du nom ou de l'éditeur, sans tenir compte des majuscules ni des accents. */
  search?: string;
  useCase?: UseCase;
  /** Capacités que le modèle doit toutes avoir. */
  capabilities?: Capability[];
  /** Seulement les modèles exécutés dans l'Union européenne. */
  euOnly?: boolean;
  sort?: LevelSort;
}

/** Tris de la page d'un niveau : les recommandés d'abord (par défaut), prix croissant, contexte décroissant ou nom. */
export const LEVEL_SORTS = ["recommended", "price", "context", "name"] as const;
export type LevelSort = (typeof LEVEL_SORTS)[number];

/** Page d'un niveau : les modèles qui répondent aux critères, et le nombre de modèles du niveau avant tout critère. */
export interface LevelModels {
  modelCount: number;
  models: LevelModel[];
}

/** Longueur minimale d'une recherche : en deçà, la recherche ne filtre pas (retours de recette du 2026-09-25). */
export const RECHERCHE_MINIMUM = 3;

/** Modèles d'un niveau : ceux qui acceptent des données de ce niveau, selon la règle de la politique d'accès. */
export async function levelModels(
  deps: CatalogDeps,
  { level, language, criteria = {} }: { level: DataLevel; language: Langue; criteria?: LevelCriteria },
): Promise<LevelModels> {
  const models: LevelModel[] = modelsOfLevel(await visibleModels(deps), level, language);
  const { search: saisie = "", useCase, capabilities = [], euOnly = false, sort = "recommended" } = criteria;
  const search = saisie.trim().length >= RECHERCHE_MINIMUM ? saisie.trim() : "";
  const blended = (m: LevelModel) => blendedPricePerMillion(m.inputPricePerMillion, m.outputPricePerMillion);
  const byName = (a: LevelModel, b: LevelModel) => a.displayName.localeCompare(b.displayName, language);
  const comparators: Record<LevelSort, (a: LevelModel, b: LevelModel) => number> = {
    recommended: (a, b) => Number(b.recommendedFor.length > 0) - Number(a.recommendedFor.length > 0) || blended(a) - blended(b) || byName(a, b),
    price: (a, b) => blended(a) - blended(b) || byName(a, b),
    context: (a, b) => (b.context?.tokens ?? -1) - (a.context?.tokens ?? -1) || byName(a, b),
    name: byName,
  };
  return {
    modelCount: models.length,
    models: models
      .filter(
        (m) =>
          [m.displayName, m.modelName, m.publisher ?? ""].some((champ) => normalized(champ).includes(normalized(search))) &&
          (!useCase || m.useCases.includes(useCase)) &&
          capabilities.every((c) => m.capabilities.includes(c)) &&
          (!euOnly || m.executionRegion === "UE"),
      )
      .sort(comparators[sort]),
  };
}

/** Détail d'un modèle (ticket #9) : sa carte, complétée de ce que présente le panneau. */
export interface ModelDetail extends LevelModel {
  longDescription: string;
  limitations: string | null;
  hosts: string[];
  apiKind: ApiKind;
}

/** Détail d'un modèle de la page d'un niveau ; null si le modèle n'est pas parmi les modèles de ce niveau. */
export async function modelDetail(
  deps: CatalogDeps,
  { level, modelName, language }: { level: DataLevel; modelName: string; language: Langue },
): Promise<ModelDetail | null> {
  return modelsOfLevel(await visibleModels(deps), level, language).find((m) => m.modelName === modelName) ?? null;
}

/** Texte d'une fiche dans la langue du salarié : un texte que l'admin n'a pas traduit s'affiche en français. */
function inLanguage(language: Langue) {
  return <T extends string | null>(fr: T, en: string | null): T | string => (language === "en" && en) || fr;
}

/**
 * Modèles d'un niveau parmi les modèles visibles, dans la langue du salarié : le seul calcul des modèles
 * d'un niveau, commun à la vue d'ensemble, à la page d'un niveau et au détail d'un modèle.
 */
function modelsOfLevel(visible: VisibleModel[], level: DataLevel, language: Langue): ModelDetail[] {
  const text = inLanguage(language);
  return visible
    .filter(({ entry }) => modelAcceptsLevel(entry.dataLevel, level))
    .map(({ entry, model, inputPricePerMillion, outputPricePerMillion }) => ({
      modelName: entry.modelName,
      displayName: text(entry.displayNameFr, entry.displayNameEn),
      shortDescription: text(entry.shortDescriptionFr, entry.shortDescriptionEn),
      publisher: model.publisher,
      executionRegion: model.executionRegion,
      capabilities: model.capabilities,
      inputPricePerMillion,
      outputPricePerMillion,
      useCases: entry.useCases,
      acceptsUpTo: entry.dataLevel === level ? null : entry.dataLevel,
      recommendedFor: entry.dataLevel === level ? entry.recommendedFor : [],
      priceTier: priceTier(blendedPricePerMillion(inputPricePerMillion, outputPricePerMillion)),
      pricePerImage: model.apiKind === "image" ? model.imagePrice : null,
      context: model.apiKind === "image" ? null : context(model.maxInputTokens),
      longDescription: text(entry.longDescriptionFr, entry.longDescriptionEn),
      limitations: text(entry.limitationsFr, entry.limitationsEn),
      hosts: model.hosts,
      apiKind: model.apiKind,
    }));
}

/** Texte comparable : en minuscules et sans accents. */
function normalized(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();
}

/** Vue d'ensemble d'un niveau de confidentialité (ticket #5). */
export interface LevelOverview {
  level: DataLevel;
  modelCount: number;
  /** Plus petit prix mixte des modèles du niveau, en euros par million de jetons ; null sans modèle. */
  startingPricePerMillion: number | null;
}

/**
 * Les quatre niveaux, avec le nombre de modèles et le prix de départ de chacun. Les modèles d'un
 * niveau suivent la règle de la politique d'accès : lecture cumulative, niveau Expérimental à part.
 */
export async function levelOverview(deps: CatalogDeps): Promise<LevelOverview[]> {
  const visible = await visibleModels(deps);
  return DATA_LEVELS.map((level) => {
    // La langue est sans effet sur le nombre de modèles et les prix.
    const prix = modelsOfLevel(visible, level, "fr").map((m) => blendedPricePerMillion(m.inputPricePerMillion, m.outputPricePerMillion));
    return { level, modelCount: prix.length, startingPricePerMillion: prix.length > 0 ? Math.min(...prix) : null };
  });
}

/** Prix mixte : 3 jetons d'entrée pour 1 jeton de sortie, convention courante des comparatifs de prix. */
export function blendedPricePerMillion(entree: number, sortie: number): number {
  return Number(((3 * entree + sortie) / 4).toFixed(6));
}

/**
 * Ligne du catalogue d'administration : un modèle de LiteLLM, ses faits techniques déclarés par la
 * passerelle (lecture seule, fournisseur compris) et sa fiche éventuelle.
 */
export interface AdminCatalogItem {
  modelName: string;
  supplier: string | null;
  publisher: string | null;
  hosts: string[];
  executionRegion: ExecutionRegion | null;
  capabilities: Capability[];
  hasEuroPricing: boolean;
  inputPricePerMillion: number | null;
  outputPricePerMillion: number | null;
  maxInputTokens: number | null;
  entry: CatalogEntryInput | null;
}

/** F-50 : tous les modèles déclarés dans LiteLLM, enrichis ou non, par ordre alphabétique. */
export async function listCatalogForAdmin(deps: CatalogDeps, actor: SessionUser): Promise<AdminCatalogItem[]> {
  requireAdmin(actor);
  const [models, entries] = await Promise.all([deps.litellm.listModels(), deps.db.catalogEntry.findMany()]);
  return models
    .map((model) => {
      const entry = entries.find((e) => e.modelName === model.modelName);
      return {
        modelName: model.modelName,
        supplier: model.supplier,
        publisher: model.publisher,
        hosts: model.hosts,
        executionRegion: model.executionRegion,
        capabilities: model.capabilities,
        hasEuroPricing: hasEuroPricing(model),
        inputPricePerMillion: model.inputCostPerToken === null ? null : perMillion(model.inputCostPerToken),
        outputPricePerMillion: model.outputCostPerToken === null ? null : perMillion(model.outputCostPerToken),
        maxInputTokens: model.maxInputTokens,
        entry: entry
          ? {
              modelName: entry.modelName,
              displayNameFr: entry.displayNameFr,
              displayNameEn: entry.displayNameEn,
              shortDescriptionFr: entry.shortDescriptionFr,
              shortDescriptionEn: entry.shortDescriptionEn,
              longDescriptionFr: entry.longDescriptionFr,
              longDescriptionEn: entry.longDescriptionEn,
              limitationsFr: entry.limitationsFr,
              limitationsEn: entry.limitationsEn,
              useCases: entry.useCases,
              recommendedFor: entry.recommendedFor,
              dataLevel: entry.dataLevel,
              visible: entry.visible,
            }
          : null,
      };
    })
    .sort((a, b) => a.modelName.localeCompare(b.modelName));
}

/** F-50 : crée ou met à jour l'enrichissement d'un modèle. */
export async function saveCatalogEntry(deps: CatalogDeps, actor: SessionUser, input: CatalogEntryInput): Promise<void> {
  requireAdmin(actor);
  const entry = catalogEntryInputSchema.parse(input);
  const horsCasUsage = entry.recommendedFor.filter((u) => !entry.useCases.includes(u));
  if (horsCasUsage.length > 0) {
    throw new PortalError("recommandation_hors_cas_usage", `Recommandation pour un cas d'usage non coché : ${horsCasUsage.join(", ")}.`);
  }
  const model = (await deps.litellm.listModels()).find((m) => m.modelName === entry.modelName);
  if (!model) throw new PortalError("introuvable", `Le modèle ${entry.modelName} n'est pas déclaré dans LiteLLM.`, { objet: "modele", modele: entry.modelName });
  if (entry.visible && !hasEuroPricing(model)) {
    throw new PortalError("tarif_eur_manquant", `Le modèle ${entry.modelName} n'a pas de tarif en euros : il ne peut pas être rendu visible.`, { modele: entry.modelName });
  }
  const data = { ...entry, updatedBy: actor.uid };
  await deps.db.catalogEntry.upsert({ where: { modelName: entry.modelName }, create: data, update: data });
}

/** F-10 : tarif explicite en euros (pricing_currency = EUR + coûts d'entrée et de sortie). */
function hasEuroPricing(model: LiteLLMModel | undefined): boolean {
  return model?.pricingCurrency === "EUR" && model.inputCostPerToken !== null && model.outputCostPerToken !== null;
}

/** Prix par jeton → prix par million de jetons, arrondi pour éviter les artefacts flottants. */
function perMillion(costPerToken: number): number {
  return Number((costPerToken * 1_000_000).toFixed(6));
}
