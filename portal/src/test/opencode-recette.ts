import type { SessionUser } from "@/lib/auth-user";
import type { Db } from "@/lib/db";
import type { LiteLLMModel } from "@/lib/litellm/client";
import type { DataLevel } from "@/lib/policy";
import { approveKeyRequest } from "@/lib/services/admin-requests";
import { saveCatalogEntry } from "@/lib/services/catalog";
import { pickUpKey } from "@/lib/services/keys";
import { createKeyRequest } from "@/lib/services/requests";
import type { FakeLiteLLM } from "./fake-litellm";

/*
 * Recette d'OpenCode (tickets #118 et #119) : faits techniques de huit modèles de la passerelle de production, relevés
 * dans /model/info le 2026-10-04, et noms affichés de leurs fiches. Les configurations produites pour ces modèles ont
 * été validées dans un vrai OpenCode 2.0.22 ; elles servent de résultat attendu aux tests de la configuration.
 *
 * Les cas couverts : efforts de raisonnement déclarés (GLM-5.3, DeepSeek V4.1 Flash, Mistral Small), raisonnement sans
 * efforts connus (Gemini 2.5 Flash, Qwen3.8), modèle sans raisonnement (Ministral 8B), modèle d'images et modèle
 * d'embeddings, à écarter (FLUX.2 [klein] 4B, BGE-M3).
 */
export const MODELES_DE_RECETTE: (Partial<LiteLLMModel> & { modelName: string })[] = [
  {
    modelName: "glm-5.3",
    supplier: "OpenRouter",
    publisher: "Z.ai (Zhipu)",
    capabilities: ["raisonnement"],
    hosts: ["Inceptron"],
    executionRegion: "UE",
    apiKind: "conversation",
    imagePrice: null,
    inputCostPerToken: 5.56875e-07,
    outputCostPerToken: 3.14635e-06,
    cacheReadCostPerToken: 1.62422e-07,
    cacheWriteCostPerToken: 5.56875e-07,
    inputCostPerTokenAbove200k: null,
    outputCostPerTokenAbove200k: null,
    fxRateUsdEur: 0.87974,
    pricingCurrency: "EUR",
    dataLevel: "N1",
    hosting: "UE",
    maxInputTokens: 1048576,
    maxOutputTokens: 131072,
    reasoningEfforts: ["low", "high", "max"],
    defaultReasoningEffort: "max",
    inputContents: ["text"],
    outputContents: ["text"],
    dimensions: null,
  },
  {
    modelName: "deepseek-v4.1-flash",
    supplier: "OpenRouter",
    publisher: "DeepSeek",
    capabilities: ["images", "raisonnement"],
    hosts: ["NextBit"],
    executionRegion: "UE",
    apiKind: "conversation",
    imagePrice: null,
    inputCostPerToken: 1.94906e-07,
    outputCostPerToken: 7.79626e-07,
    cacheReadCostPerToken: 3.7125e-09,
    cacheWriteCostPerToken: 1.94906e-07,
    inputCostPerTokenAbove200k: null,
    outputCostPerTokenAbove200k: null,
    fxRateUsdEur: 0.87974,
    pricingCurrency: "EUR",
    dataLevel: "N1",
    hosting: "UE",
    maxInputTokens: 1048576,
    maxOutputTokens: 943718,
    reasoningEfforts: ["low", "high", "max"],
    defaultReasoningEffort: "high",
    inputContents: ["text", "image"],
    outputContents: ["text"],
    dimensions: null,
  },
  {
    modelName: "mistral-small-2603",
    supplier: "OpenRouter",
    publisher: "Mistral AI",
    capabilities: ["images", "raisonnement"],
    hosts: ["Mistral"],
    executionRegion: "UE",
    apiKind: "conversation",
    imagePrice: null,
    inputCostPerToken: 1.53141e-07,
    outputCostPerToken: 6.12563e-07,
    cacheReadCostPerToken: 1.53141e-08,
    cacheWriteCostPerToken: 1.53141e-07,
    inputCostPerTokenAbove200k: null,
    outputCostPerTokenAbove200k: null,
    fxRateUsdEur: 0.87974,
    pricingCurrency: "EUR",
    dataLevel: "N1",
    hosting: "UE",
    maxInputTokens: 262144,
    maxOutputTokens: 209715,
    reasoningEfforts: ["none", "high"],
    defaultReasoningEffort: "high",
    inputContents: ["text", "image"],
    outputContents: ["text"],
    dimensions: null,
  },
  {
    modelName: "ministral-8b",
    supplier: "OpenRouter",
    publisher: "Mistral AI",
    capabilities: ["images"],
    hosts: ["Mistral"],
    executionRegion: "UE",
    apiKind: "conversation",
    imagePrice: null,
    inputCostPerToken: 1.53141e-07,
    outputCostPerToken: 1.53141e-07,
    cacheReadCostPerToken: 1.53141e-08,
    cacheWriteCostPerToken: 1.53141e-07,
    inputCostPerTokenAbove200k: null,
    outputCostPerTokenAbove200k: null,
    fxRateUsdEur: 0.87974,
    pricingCurrency: "EUR",
    dataLevel: "N1",
    hosting: "UE",
    maxInputTokens: 262144,
    maxOutputTokens: 209715,
    reasoningEfforts: null,
    defaultReasoningEffort: null,
    inputContents: ["text", "image"],
    outputContents: ["text"],
    dimensions: null,
  },
  {
    modelName: "gemini-2.5-flash",
    supplier: "OpenRouter",
    publisher: "Google",
    capabilities: ["images", "audio_video", "raisonnement"],
    hosts: ["Google"],
    executionRegion: "UE",
    apiKind: "conversation",
    imagePrice: null,
    inputCostPerToken: 2.78438e-07,
    outputCostPerToken: 2.32031e-06,
    cacheReadCostPerToken: 2.78438e-08,
    cacheWriteCostPerToken: 7.73438e-08,
    inputCostPerTokenAbove200k: null,
    outputCostPerTokenAbove200k: null,
    fxRateUsdEur: 0.87974,
    pricingCurrency: "EUR",
    dataLevel: "N1",
    hosting: "UE",
    maxInputTokens: 1048576,
    maxOutputTokens: 65535,
    reasoningEfforts: null,
    defaultReasoningEffort: null,
    inputContents: ["text", "image", "pdf", "audio", "video"],
    outputContents: ["text"],
    dimensions: null,
  },
  {
    modelName: "qwen3.8",
    supplier: "OVHcloud",
    publisher: "Alibaba (Qwen)",
    capabilities: ["images", "raisonnement"],
    hosts: ["OVHcloud"],
    executionRegion: "UE",
    apiKind: "conversation",
    imagePrice: null,
    inputCostPerToken: 4e-07,
    outputCostPerToken: 2.7e-06,
    cacheReadCostPerToken: null,
    cacheWriteCostPerToken: null,
    inputCostPerTokenAbove200k: null,
    outputCostPerTokenAbove200k: null,
    fxRateUsdEur: 0.87974,
    pricingCurrency: "EUR",
    dataLevel: "N3",
    hosting: "INTERNE_OVH",
    maxInputTokens: 262144,
    maxOutputTokens: 262144,
    reasoningEfforts: null,
    defaultReasoningEffort: null,
    inputContents: ["text", "image"],
    outputContents: ["text"],
    dimensions: null,
  },
  {
    modelName: "flux.2-klein-4b",
    supplier: "OpenRouter",
    publisher: "Black Forest Labs",
    capabilities: ["images", "generation_images"],
    hosts: ["Black Forest Labs"],
    executionRegion: "HORS_UE",
    apiKind: "image",
    imagePrice: 0.013,
    inputCostPerToken: 0.0,
    outputCostPerToken: 4.22995e-06,
    cacheReadCostPerToken: 0.0,
    cacheWriteCostPerToken: 0.0,
    inputCostPerTokenAbove200k: null,
    outputCostPerTokenAbove200k: null,
    fxRateUsdEur: 0.87974,
    pricingCurrency: "EUR",
    dataLevel: "N1",
    hosting: "HORS_UE",
    maxInputTokens: 40960,
    maxOutputTokens: 36864,
    reasoningEfforts: null,
    defaultReasoningEffort: null,
    inputContents: ["text", "image"],
    outputContents: ["image"],
    dimensions: null,
  },
  {
    modelName: "bge-m3",
    supplier: "OVHcloud",
    publisher: "BAAI",
    capabilities: [],
    hosts: ["OVHcloud"],
    executionRegion: "UE",
    apiKind: "embeddings",
    imagePrice: null,
    inputCostPerToken: 1e-08,
    outputCostPerToken: 0.0,
    cacheReadCostPerToken: null,
    cacheWriteCostPerToken: null,
    inputCostPerTokenAbove200k: null,
    outputCostPerTokenAbove200k: null,
    fxRateUsdEur: 0.87974,
    pricingCurrency: "EUR",
    dataLevel: "N3",
    hosting: "INTERNE_OVH",
    maxInputTokens: 8192,
    maxOutputTokens: null,
    reasoningEfforts: null,
    defaultReasoningEffort: null,
    inputContents: null,
    outputContents: null,
    dimensions: 1024,
  },
];

/** Fiches de ces modèles, telles qu'en production : nom affiché et niveau maximal. */
export const FICHES_DE_RECETTE: { modelName: string; displayNameFr: string; displayNameEn: string; dataLevel: DataLevel }[] = [
  { modelName: "glm-5.3", displayNameFr: "GLM-5.3", displayNameEn: "GLM-5.3", dataLevel: "N1" },
  { modelName: "deepseek-v4.1-flash", displayNameFr: "DeepSeek V4.1 Flash", displayNameEn: "DeepSeek V4.1 Flash", dataLevel: "N1" },
  { modelName: "mistral-small-2603", displayNameFr: "Mistral Small (2603)", displayNameEn: "Mistral Small (2603)", dataLevel: "N1" },
  { modelName: "ministral-8b", displayNameFr: "Ministral 8B", displayNameEn: "Ministral 8B", dataLevel: "N1" },
  { modelName: "gemini-2.5-flash", displayNameFr: "Gemini 2.5 Flash", displayNameEn: "Gemini 2.5 Flash", dataLevel: "N1" },
  { modelName: "qwen3.8", displayNameFr: "Qwen3.8 27B", displayNameEn: "Qwen3.8 27B", dataLevel: "N3" },
  { modelName: "flux.2-klein-4b", displayNameFr: "FLUX.2 [klein] 4B", displayNameEn: "FLUX.2 [klein] 4B", dataLevel: "N1" },
  { modelName: "bge-m3", displayNameFr: "BGE-M3", displayNameEn: "BGE-M3", dataLevel: "N3" },
];

/** Équipe neutre des clés de recette : le dépôt est public. */
export const EQUIPE_DE_RECETTE = { teamId: "equipe-recette", teamAlias: "Équipe recette" };

/**
 * Clés de recette du titulaire, émises dans l'équipe neutre : une clé N1 avec les huit modèles, et une clé N3, pour le
 * projet « Base vectorielle », avec Qwen3.8 et BGE-M3. Les modèles et leurs fiches sont déclarés au passage. Rend les
 * identifiants des deux demandes.
 */
export async function clesDeRecette(
  deps: { db: Db; litellm: FakeLiteLLM; now?: () => Date },
  admin: SessionUser,
  titulaire: SessionUser,
): Promise<{ n1: string; n3: string }> {
  for (const modele of MODELES_DE_RECETTE) deps.litellm.withModel(modele);
  deps.litellm.withTeam({ ...EQUIPE_DE_RECETTE, models: [], memberUids: [titulaire.uid] });
  for (const fiche of FICHES_DE_RECETTE) {
    await saveCatalogEntry(deps, admin, { ...fiche, shortDescriptionFr: "…", longDescriptionFr: "…", useCases: [], recommendedFor: [], visible: true });
  }
  const cle = async (dataLevel: DataLevel, models: string[], project: string | null) => {
    const demande = { teamId: EQUIPE_DE_RECETTE.teamId, dataLevel, models, justification: "Recette d'OpenCode", project, requestedBudget: 20, requestedDays: 90, commitment: true };
    const { id } = await createKeyRequest(deps, titulaire, demande);
    await approveKeyRequest(deps, admin, id, { models, budget: 15, budgetDuration: "30d", days: 60, rpmLimit: null, tpmLimit: null });
    await pickUpKey(deps, titulaire, id);
    return id;
  };
  return {
    n1: await cle("N1", MODELES_DE_RECETTE.map((m) => m.modelName), null),
    n3: await cle("N3", ["qwen3.8", "bge-m3"], "Base vectorielle"),
  };
}

