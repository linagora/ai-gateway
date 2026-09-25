import { z } from "zod";
import type { SessionUser } from "@/lib/auth-user";
import type { Db } from "@/lib/db";
import type { Capability, ExecutionRegion, LiteLLMClient, LiteLLMModel } from "@/lib/litellm/client";
import { PortalError } from "@/lib/errors";
import { DATA_LEVELS, type DataLevel } from "@/lib/policy";
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

/** F-10 : modèles de LiteLLM enrichis et rendus visibles par un admin. */
export async function listCatalog(deps: CatalogDeps): Promise<CatalogItem[]> {
  const [models, entries] = await Promise.all([deps.litellm.listModels(), deps.db.catalogEntry.findMany({ where: { visible: true } })]);
  return entries.flatMap((entry) => {
    const model = models.find((m) => m.modelName === entry.modelName);
    if (!model || model.inputCostPerToken === null || model.outputCostPerToken === null) return [];
    return [
      {
        modelName: entry.modelName,
        displayName: entry.displayNameFr,
        description: entry.shortDescriptionFr,
        useCases: entry.useCases,
        publisher: model.publisher,
        executionRegion: model.executionRegion,
        dataLevel: entry.dataLevel,
        inputPricePerMillion: perMillion(model.inputCostPerToken),
        outputPricePerMillion: perMillion(model.outputCostPerToken),
        maxInputTokens: model.maxInputTokens,
      },
    ];
  });
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
