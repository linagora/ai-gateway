import { beforeEach, describe, expect, test } from "vitest";
import { resetDb, testDb } from "@/test/db";
import { FakeLiteLLM } from "@/test/fake-litellm";
import { type CatalogEntryInput, levelOverview, listCatalog, listCatalogForAdmin, saveCatalogEntry } from "./catalog";

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

describe("vue d'ensemble des niveaux (ticket #5)", () => {
  // Prix par jeton en euros : prix mixte = (3 × entrée + sortie) / 4, par million de jetons.
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
