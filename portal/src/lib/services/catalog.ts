import { z } from "zod";
import type { SessionUser } from "@/lib/auth-user";
import type { Db } from "@/lib/db";
import type { LiteLLMClient, LiteLLMModel } from "@/lib/litellm/client";
import { PortalError } from "@/lib/errors";
import type { DataLevel } from "@/lib/policy";
import { requireAdmin } from "@/lib/rbac";

/** Enrichissement d'un modèle saisi par un admin (F-50). */
export const catalogEntryInputSchema = z.object({
  modelName: z.string().min(1),
  displayName: z.string().trim().min(1),
  description: z.string().trim().min(1),
  useCases: z.string().trim().nullable(),
  category: z.string().trim().nullable(),
  hosting: z.enum(["INTERNE", "UE", "HORS_UE"]),
  dataLevel: z.enum(["N1", "N2", "N3"]),
  visible: z.boolean(),
});

export type CatalogEntryInput = z.infer<typeof catalogEntryInputSchema>;

/** Modèle tel que présenté aux utilisateurs (F-11). Prix en euros par million de jetons. */
export interface CatalogItem {
  modelName: string;
  displayName: string;
  description: string;
  useCases: string | null;
  category: string | null;
  provider: string | null;
  dataLevel: DataLevel;
  hosting: string;
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
        displayName: entry.displayName,
        description: entry.description,
        useCases: entry.useCases,
        category: entry.category,
        provider: model.provider,
        dataLevel: entry.dataLevel,
        hosting: entry.hosting,
        inputPricePerMillion: perMillion(model.inputCostPerToken),
        outputPricePerMillion: perMillion(model.outputCostPerToken),
        maxInputTokens: model.maxInputTokens,
      },
    ];
  });
}

/** Ligne du catalogue d'administration : un modèle de LiteLLM et son enrichissement éventuel. */
export interface AdminCatalogItem {
  modelName: string;
  provider: string | null;
  hasEuroPricing: boolean;
  inputPricePerMillion: number | null;
  outputPricePerMillion: number | null;
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
        provider: model.provider,
        hasEuroPricing: hasEuroPricing(model),
        inputPricePerMillion: model.inputCostPerToken === null ? null : perMillion(model.inputCostPerToken),
        outputPricePerMillion: model.outputCostPerToken === null ? null : perMillion(model.outputCostPerToken),
        entry: entry
          ? {
              modelName: entry.modelName,
              displayName: entry.displayName,
              description: entry.description,
              useCases: entry.useCases,
              category: entry.category,
              hosting: entry.hosting as CatalogEntryInput["hosting"],
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
  const model = (await deps.litellm.listModels()).find((m) => m.modelName === entry.modelName);
  if (!model) throw new PortalError("introuvable", `Le modèle ${entry.modelName} n'est pas déclaré dans LiteLLM.`);
  if (entry.visible && !hasEuroPricing(model)) {
    throw new PortalError("tarif_eur_manquant", `Le modèle ${entry.modelName} n'a pas de tarif en euros : il ne peut pas être rendu visible.`);
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
