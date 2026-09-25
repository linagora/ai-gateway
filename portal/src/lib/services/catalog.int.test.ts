import { beforeEach, describe, expect, test } from "vitest";
import type { Langue } from "@/lib/langue";
import { DATA_LEVELS, type DataLevel } from "@/lib/policy";
import { resetDb, testDb } from "@/test/db";
import { FakeLiteLLM } from "@/test/fake-litellm";
import type { UseCase } from "@/lib/use-cases";
import { type CatalogEntryInput, type LevelCriteria, type LevelSort, levelModels, levelOverview, listCatalog, listCatalogForAdmin, saveCatalogEntry } from "./catalog";

beforeEach(resetDb);

const admin = { uid: "mmaudet", email: "mmaudet@linagora.com", name: "Michel-Marie Maudet", isAdmin: true };

const qwen: CatalogEntryInput = {
  modelName: "qwen3.8",
  displayNameFr: "Qwen 3.8 27B",
  displayNameEn: null,
  shortDescriptionFr: "Modèle généraliste hébergé par OVHcloud",
  shortDescriptionEn: null,
  longDescriptionFr: "Modèle ouvert généraliste, hébergé en France par OVHcloud, pour les données confidentielles.",
  longDescriptionEn: null,
  limitationsFr: null,
  limitationsEn: null,
  useCases: ["WRITING", "DOCUMENT_ANALYSIS"],
  recommendedFor: ["WRITING"],
  dataLevel: "N3",
  visible: true,
};

describe("fiche de modèle bilingue (ticket #6)", () => {
  test("l'admin enregistre une fiche avec ses seuls textes français, puis la complète en anglais", async () => {
    const litellm = new FakeLiteLLM().withModel({ modelName: "qwen3.8" });
    await saveCatalogEntry({ db: testDb, litellm }, admin, qwen);
    expect((await listCatalogForAdmin({ db: testDb, litellm }, admin))[0].entry).toMatchObject({ displayNameFr: "Qwen 3.8 27B", displayNameEn: null });
    await saveCatalogEntry({ db: testDb, litellm }, admin, {
      ...qwen,
      displayNameEn: "Qwen 3.8 27B",
      shortDescriptionEn: "General-purpose model hosted by OVHcloud",
      longDescriptionEn: "Open general-purpose model, hosted in France by OVHcloud, for confidential data.",
    });
    expect((await listCatalogForAdmin({ db: testDb, litellm }, admin))[0].entry).toMatchObject({
      displayNameFr: "Qwen 3.8 27B",
      displayNameEn: "Qwen 3.8 27B",
      shortDescriptionEn: "General-purpose model hosted by OVHcloud",
      useCases: ["WRITING", "DOCUMENT_ANALYSIS"],
      recommendedFor: ["WRITING"],
    });
  });
});

// Un modèle par niveau. Prix par jeton en euros : prix mixte = (3 × entrée + sortie) / 4, par million de jetons.
const modeles = [
  { modelName: "public", dataLevel: "N1" as const, inputCostPerToken: 0.0000001, outputCostPerToken: 0.0000004 }, // mixte 0,175 €
  { modelName: "interne", dataLevel: "N2" as const, inputCostPerToken: 0.0000002, outputCostPerToken: 0.0000006 }, // mixte 0,30 €
  { modelName: "confidentiel", dataLevel: "N3" as const, inputCostPerToken: 0.0000004, outputCostPerToken: 0.0000027 }, // mixte 0,975 €
  { modelName: "beta", dataLevel: "EXP" as const, inputCostPerToken: 0.0000002, outputCostPerToken: 0 }, // mixte 0,15 €
];

async function catalogueDeDemonstration(visibles = modeles.map((m) => m.modelName)) {
  const litellm = new FakeLiteLLM();
  for (const m of modeles) litellm.withModel({ modelName: m.modelName, inputCostPerToken: m.inputCostPerToken, outputCostPerToken: m.outputCostPerToken });
  for (const m of modeles) {
    await saveCatalogEntry({ db: testDb, litellm }, admin, { ...qwen, modelName: m.modelName, dataLevel: m.dataLevel, visible: visibles.includes(m.modelName) });
  }
  return litellm;
}

describe("vue d'ensemble des niveaux (ticket #5)", () => {
  test("chaque niveau compte ses modèles en lecture cumulative, le niveau Expérimental à part", async () => {
    const litellm = await catalogueDeDemonstration();
    expect((await levelOverview({ db: testDb, litellm })).map((n) => [n.level, n.modelCount])).toEqual([
      ["N1", 3],
      ["N2", 2],
      ["N3", 1],
      ["EXP", 1],
    ]);
  });

  test("le prix de départ d'un niveau est le plus petit prix mixte de ses modèles", async () => {
    const litellm = await catalogueDeDemonstration();
    expect((await levelOverview({ db: testDb, litellm })).map((n) => [n.level, n.startingPricePerMillion])).toEqual([
      ["N1", 0.175],
      ["N2", 0.3],
      ["N3", 0.975],
      ["EXP", 0.15],
    ]);
  });

  test("un niveau sans modèle visible n'a ni modèle ni prix de départ", async () => {
    const litellm = await catalogueDeDemonstration(["public", "interne", "confidentiel"]);
    expect((await levelOverview({ db: testDb, litellm })).find((n) => n.level === "EXP")).toEqual({ level: "EXP", modelCount: 0, startingPricePerMillion: null });
  });
});

describe("page d'un niveau (ticket #7)", () => {
  test("la carte d'un modèle montre son nom, son éditeur, sa zone, ses capacités, ses prix, sa description courte et ses cas d'usage", async () => {
    const litellm = new FakeLiteLLM().withModel({
      modelName: "qwen3.8",
      publisher: "Alibaba (Qwen)",
      executionRegion: "UE",
      capabilities: ["images", "raisonnement"],
      inputCostPerToken: 0.0000004,
      outputCostPerToken: 0.0000027,
    });
    await saveCatalogEntry({ db: testDb, litellm }, admin, qwen);
    expect((await levelModels({ db: testDb, litellm }, { level: "N3", language: "fr" })).models).toMatchObject([
      {
        modelName: "qwen3.8",
        displayName: "Qwen 3.8 27B",
        shortDescription: "Modèle généraliste hébergé par OVHcloud",
        publisher: "Alibaba (Qwen)",
        executionRegion: "UE",
        capabilities: ["images", "raisonnement"],
        inputPricePerMillion: 0.4,
        outputPricePerMillion: 2.7,
        useCases: ["WRITING", "DOCUMENT_ANALYSIS"],
      },
    ]);
  });

  const niveau = async (litellm: FakeLiteLLM, level: DataLevel, language: Langue = "fr") => (await levelModels({ db: testDb, litellm }, { level, language })).models;

  test("la page N2 montre les modèles de niveau maximal N2 et N3, ces derniers avec le badge « accepte jusqu'à N3 »", async () => {
    const litellm = await catalogueDeDemonstration();
    expect(Object.fromEntries((await niveau(litellm, "N2")).map((m) => [m.modelName, m.acceptsUpTo]))).toEqual({ interne: null, confidentiel: "N3" });
  });

  test("la page Expérimental ne montre que les modèles expérimentaux, qui n'apparaissent sur aucune autre page", async () => {
    const litellm = await catalogueDeDemonstration();
    const pages = await Promise.all(DATA_LEVELS.map(async (level) => [level, (await niveau(litellm, level)).map((m) => m.modelName).sort()]));
    expect(Object.fromEntries(pages)).toEqual({ N1: ["confidentiel", "interne", "public"], N2: ["confidentiel", "interne"], N3: ["confidentiel"], EXP: ["beta"] });
  });

  test("le repère de prix suit le prix mixte : 0,29 € donne €, 0,30 € donne €€, 1 € donne €€€", async () => {
    const litellm = new FakeLiteLLM()
      .withModel({ modelName: "a-0,29", inputCostPerToken: 0.0000002, outputCostPerToken: 0.00000056 }) // (3 × 0,20 + 0,56) / 4 = 0,29 €
      .withModel({ modelName: "b-0,30", inputCostPerToken: 0.0000002, outputCostPerToken: 0.0000006 }) // (3 × 0,20 + 0,60) / 4 = 0,30 €
      .withModel({ modelName: "c-1", inputCostPerToken: 0.000001, outputCostPerToken: 0.000001 }); // (3 × 1 + 1) / 4 = 1 €
    for (const { modelName } of litellm.models) await saveCatalogEntry({ db: testDb, litellm }, admin, { ...qwen, modelName, dataLevel: "N1" });
    expect(Object.fromEntries((await niveau(litellm, "N1")).map((m) => [m.modelName, m.priceTier]))).toEqual({ "a-0,29": "€", "b-0,30": "€€", "c-1": "€€€" });
  });

  test("le contexte est arrondi au millier de jetons et converti en pages d'environ 750 jetons", async () => {
    const litellm = new FakeLiteLLM()
      .withModel({ modelName: "qwen", maxInputTokens: 262_144 }) // 349,5 pages
      .withModel({ modelName: "gemini", maxInputTokens: 1_048_576 }) // 1 398 pages, arrondies à deux chiffres significatifs
      .withModel({ modelName: "petit", maxInputTokens: 32_768 }) // 43,7 pages
      .withModel({ modelName: "inconnu", maxInputTokens: null });
    for (const { modelName } of litellm.models) await saveCatalogEntry({ db: testDb, litellm }, admin, { ...qwen, modelName, dataLevel: "N1" });
    expect(Object.fromEntries((await niveau(litellm, "N1")).map((m) => [m.modelName, m.context]))).toEqual({
      qwen: { tokens: 262_000, pages: 350 },
      gemini: { tokens: 1_049_000, pages: 1_400 },
      petit: { tokens: 33_000, pages: 44 },
      inconnu: null,
    });
  });

  test("en anglais, un modèle montre ses textes anglais, et ses textes français quand l'admin ne les a pas traduits", async () => {
    const litellm = new FakeLiteLLM().withModel({ modelName: "qwen3.8" }).withModel({ modelName: "mistral-medium" });
    await saveCatalogEntry({ db: testDb, litellm }, admin, { ...qwen, displayNameEn: "Qwen 3.8 27B (EN)", shortDescriptionEn: "General-purpose model hosted by OVHcloud" });
    await saveCatalogEntry({ db: testDb, litellm }, admin, { ...qwen, modelName: "mistral-medium", displayNameFr: "Mistral Medium", shortDescriptionFr: "Modèle polyvalent de Mistral AI" });
    const textes = async (language: Langue) =>
      Object.fromEntries((await niveau(litellm, "N3", language)).map((m) => [m.modelName, [m.displayName, m.shortDescription]]));
    expect(await textes("en")).toEqual({
      "qwen3.8": ["Qwen 3.8 27B (EN)", "General-purpose model hosted by OVHcloud"],
      "mistral-medium": ["Mistral Medium", "Modèle polyvalent de Mistral AI"],
    });
    expect((await textes("fr"))["qwen3.8"]).toEqual(["Qwen 3.8 27B", "Modèle généraliste hébergé par OVHcloud"]);
  });
});

describe("filtres, tri et recommandations (ticket #8)", () => {
  // Trois modèles N1. Prix mixtes : Mistral Medium 0,80 €, Kimi K3 1,075 €, Ministral 0,10 €.
  async function catalogueFiltrable() {
    const litellm = new FakeLiteLLM()
      .withModel({ modelName: "mistral-medium", publisher: "Mistral AI", executionRegion: "UE", capabilities: ["images"], inputCostPerToken: 0.0000004, outputCostPerToken: 0.000002, maxInputTokens: 128_000 })
      .withModel({ modelName: "kimi-k3", publisher: "Moonshot AI", executionRegion: "HORS_UE", capabilities: ["images", "raisonnement"], inputCostPerToken: 0.0000006, outputCostPerToken: 0.0000025, maxInputTokens: 262_144 })
      .withModel({ modelName: "ministral-8b", publisher: "Mistral AI", executionRegion: "UE", capabilities: [], inputCostPerToken: 0.0000001, outputCostPerToken: 0.0000001, maxInputTokens: 32_768 });
    const fiche = (modelName: string, displayNameFr: string, useCases: UseCase[], recommendedFor: UseCase[]) =>
      saveCatalogEntry({ db: testDb, litellm }, admin, { ...qwen, modelName, displayNameFr, useCases, recommendedFor, dataLevel: "N1" });
    await fiche("mistral-medium", "Mistral Medium 3.5", ["WRITING", "CODING"], []);
    await fiche("kimi-k3", "Kimi K3", ["CODING", "REASONING"], ["CODING"]);
    await fiche("ministral-8b", "Ministral 8B", ["EXTRACTION", "TRANSLATION"], []);
    return litellm;
  }

  const noms = async (litellm: FakeLiteLLM, criteria: LevelCriteria) =>
    (await levelModels({ db: testDb, litellm }, { level: "N1", language: "fr", criteria })).models.map((m) => m.displayName).sort();

  test("la recherche trouve un modèle par une partie de son nom ou de son éditeur, sans tenir compte des majuscules ni des accents", async () => {
    const litellm = await catalogueFiltrable();
    expect(await noms(litellm, { search: "kimi" })).toEqual(["Kimi K3"]);
    expect(await noms(litellm, { search: "moonshot" })).toEqual(["Kimi K3"]);
    expect(await noms(litellm, { search: "mistral" })).toEqual(["Ministral 8B", "Mistral Medium 3.5"]);
    expect(await noms(litellm, { search: "MÉDIUM" })).toEqual(["Mistral Medium 3.5"]);
  });

  test("les filtres par cas d'usage, par capacités et « UE uniquement » se combinent, sans changer le nombre de modèles du niveau", async () => {
    const litellm = await catalogueFiltrable();
    expect(await noms(litellm, { useCase: "CODING" })).toEqual(["Kimi K3", "Mistral Medium 3.5"]);
    expect(await noms(litellm, { capabilities: ["images"] })).toEqual(["Kimi K3", "Mistral Medium 3.5"]);
    expect(await noms(litellm, { capabilities: ["images", "raisonnement"] })).toEqual(["Kimi K3"]);
    expect(await noms(litellm, { euOnly: true })).toEqual(["Ministral 8B", "Mistral Medium 3.5"]);
    expect(await noms(litellm, { useCase: "CODING", capabilities: ["images"], euOnly: true })).toEqual(["Mistral Medium 3.5"]);
    const aucun = await levelModels({ db: testDb, litellm }, { level: "N1", language: "fr", criteria: { useCase: "CODING", capabilities: ["raisonnement"], euOnly: true } });
    expect(aucun).toEqual({ modelCount: 3, models: [] });
  });

  test("une recommandation ne vaut que sur la page du niveau maximal du modèle", async () => {
    // Catalogue de démonstration : chaque modèle est recommandé pour la rédaction et la synthèse.
    const litellm = await catalogueDeDemonstration();
    const recommandations = async (level: DataLevel) =>
      Object.fromEntries((await levelModels({ db: testDb, litellm }, { level, language: "fr" })).models.map((m) => [m.modelName, m.recommendedFor]));
    expect(await recommandations("N2")).toEqual({ interne: ["WRITING"], confidentiel: [] });
    expect(await recommandations("N3")).toEqual({ confidentiel: ["WRITING"] });
  });

  test("le tri par défaut place en tête les modèles recommandés, puis les autres par prix mixte croissant ; les autres tris suivent le prix, le contexte ou le nom", async () => {
    const litellm = await catalogueFiltrable();
    const ordre = async (sort?: LevelSort) =>
      (await levelModels({ db: testDb, litellm }, { level: "N1", language: "fr", criteria: { sort } })).models.map((m) => m.displayName);
    // Kimi K3, recommandé pour le code, passe devant Ministral 8B (0,10 €) et Mistral Medium (0,80 €), pourtant moins chers.
    expect(await ordre()).toEqual(["Kimi K3", "Ministral 8B", "Mistral Medium 3.5"]);
    expect(await ordre("recommended")).toEqual(["Kimi K3", "Ministral 8B", "Mistral Medium 3.5"]);
    expect(await ordre("price")).toEqual(["Ministral 8B", "Mistral Medium 3.5", "Kimi K3"]);
    expect(await ordre("context")).toEqual(["Kimi K3", "Mistral Medium 3.5", "Ministral 8B"]);
    expect(await ordre("name")).toEqual(["Kimi K3", "Ministral 8B", "Mistral Medium 3.5"]);
  });
});

describe("validation de la fiche (ticket #6)", () => {
  const litellm = () => new FakeLiteLLM().withModel({ modelName: "qwen3.8" });

  test("une recommandation pour un cas d'usage non coché est refusée", async () => {
    await expect(saveCatalogEntry({ db: testDb, litellm: litellm() }, admin, { ...qwen, useCases: ["WRITING"], recommendedFor: ["CODING"] })).rejects.toMatchObject({
      code: "recommandation_hors_cas_usage",
    });
  });

  test("une fiche sans nom affiché ou sans description courte en français est refusée", async () => {
    await expect(saveCatalogEntry({ db: testDb, litellm: litellm() }, admin, { ...qwen, displayNameFr: "  " })).rejects.toThrow();
    await expect(saveCatalogEntry({ db: testDb, litellm: litellm() }, admin, { ...qwen, shortDescriptionFr: "" })).rejects.toThrow();
  });

  test("un cas d'usage hors de la liste fermée est refusé", async () => {
    await expect(
      saveCatalogEntry({ db: testDb, litellm: litellm() }, admin, { ...qwen, useCases: ["POESIE" as never], recommendedFor: [] }),
    ).rejects.toThrow();
  });
});

describe("faits techniques pour l'admin (ticket #6)", () => {
  test("l'admin voit les faits techniques déclarés par la passerelle, fournisseur compris", async () => {
    const litellm = new FakeLiteLLM().withModel({
      modelName: "qwen3.8",
      supplier: "OVHcloud",
      publisher: "Alibaba (Qwen)",
      hosts: ["OVHcloud"],
      executionRegion: "UE",
      capabilities: ["images", "raisonnement"],
      inputCostPerToken: 0.0000004,
      outputCostPerToken: 0.0000027,
      maxInputTokens: 262144,
    });
    expect(await listCatalogForAdmin({ db: testDb, litellm }, admin)).toMatchObject([
      {
        modelName: "qwen3.8",
        supplier: "OVHcloud",
        publisher: "Alibaba (Qwen)",
        hosts: ["OVHcloud"],
        executionRegion: "UE",
        capabilities: ["images", "raisonnement"],
        inputPricePerMillion: 0.4,
        outputPricePerMillion: 2.7,
        maxInputTokens: 262144,
        entry: null,
      },
    ]);
  });
});

describe("catalogue des utilisateurs (F-10)", () => {
  test("un modèle déclaré dans LiteLLM mais non enrichi n'est pas visible", async () => {
    const litellm = new FakeLiteLLM().withModel({ modelName: "qwen3.8" });
    expect(await listCatalog({ db: testDb, litellm })).toEqual([]);
  });

  test("un modèle du catalogue montre l'éditeur et la zone d'exécution déclarés par la passerelle, jamais le fournisseur", async () => {
    const litellm = new FakeLiteLLM().withModel({ modelName: "qwen3.8", supplier: "OVHcloud", publisher: "Alibaba (Qwen)", executionRegion: "UE" });
    await saveCatalogEntry({ db: testDb, litellm }, admin, qwen);
    const [modele] = await listCatalog({ db: testDb, litellm });
    expect(modele).toMatchObject({ publisher: "Alibaba (Qwen)", executionRegion: "UE" });
    expect(modele).not.toHaveProperty("supplier");
    expect(modele).not.toHaveProperty("provider");
  });

  test("un modèle enrichi et visible apparaît avec ses prix en euros par million de jetons", async () => {
    const litellm = new FakeLiteLLM().withModel({ modelName: "qwen3.8", inputCostPerToken: 0.0000004, outputCostPerToken: 0.0000027 });
    await saveCatalogEntry({ db: testDb, litellm }, admin, qwen);
    expect(await listCatalog({ db: testDb, litellm })).toEqual([
      {
        modelName: "qwen3.8",
        displayName: "Qwen 3.8 27B",
        description: "Modèle généraliste hébergé par OVHcloud",
        useCases: ["WRITING", "DOCUMENT_ANALYSIS"],
        publisher: null,
        executionRegion: "UE",
        dataLevel: "N3",
        inputPricePerMillion: 0.4,
        outputPricePerMillion: 2.7,
        maxInputTokens: 128000,
      },
    ]);
  });

  test("un modèle enrichi mais masqué n'apparaît pas", async () => {
    const litellm = new FakeLiteLLM().withModel({ modelName: "qwen3.8" });
    await saveCatalogEntry({ db: testDb, litellm }, admin, { ...qwen, visible: false });
    expect(await listCatalog({ db: testDb, litellm })).toEqual([]);
  });
});

describe("catalogue d'administration (F-50)", () => {
  test("l'admin voit tous les modèles de LiteLLM, enrichis ou non, avec l'état de leur tarif", async () => {
    const litellm = new FakeLiteLLM().withModel({ modelName: "qwen3.8" }).withModel({ modelName: "modele-sans-tarif", pricingCurrency: null });
    await saveCatalogEntry({ db: testDb, litellm }, admin, qwen);
    expect(await listCatalogForAdmin({ db: testDb, litellm }, admin)).toMatchObject([
      { modelName: "modele-sans-tarif", hasEuroPricing: false, entry: null },
      { modelName: "qwen3.8", hasEuroPricing: true, entry: { displayNameFr: "Qwen 3.8 27B", dataLevel: "N3", visible: true } },
    ]);
  });
});

describe("enrichissement du catalogue (F-50)", () => {
  test("un modèle sans tarif en euros ne peut pas être rendu visible", async () => {
    const litellm = new FakeLiteLLM().withModel({ modelName: "qwen3.8", pricingCurrency: null });
    await expect(saveCatalogEntry({ db: testDb, litellm }, admin, qwen)).rejects.toMatchObject({ code: "tarif_eur_manquant" });
  });

  test("un utilisateur qui n'est pas admin ne peut pas enrichir le catalogue", async () => {
    const litellm = new FakeLiteLLM().withModel({ modelName: "qwen3.8" });
    const salarie = { ...admin, uid: "pmartin", isAdmin: false };
    await expect(saveCatalogEntry({ db: testDb, litellm }, salarie, qwen)).rejects.toMatchObject({ code: "interdit" });
  });

  test("un modèle inconnu de LiteLLM ne peut pas être enrichi", async () => {
    const litellm = new FakeLiteLLM();
    await expect(saveCatalogEntry({ db: testDb, litellm }, admin, { ...qwen, visible: false })).rejects.toMatchObject({ code: "introuvable" });
  });
});
