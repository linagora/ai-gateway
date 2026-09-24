import { beforeEach, describe, expect, test } from "vitest";
import { resetDb, testDb } from "@/test/db";
import { FakeLiteLLM } from "@/test/fake-litellm";
import { type CatalogEntryInput, listCatalog, listCatalogForAdmin, saveCatalogEntry } from "./catalog";

beforeEach(resetDb);

const admin = { uid: "mmaudet", email: "mmaudet@linagora.com", name: "Michel-Marie Maudet", isAdmin: true };

const qwen: CatalogEntryInput = {
  modelName: "qwen3.8",
  displayName: "Qwen 3.8 27B",
  description: "Modèle généraliste hébergé par OVHcloud",
  useCases: "Synthèse de documents confidentiels",
  category: "texte",
  hosting: "UE",
  dataLevel: "N3",
  visible: true,
};

describe("catalogue des utilisateurs (F-10)", () => {
  test("un modèle déclaré dans LiteLLM mais non enrichi n'est pas visible", async () => {
    const litellm = new FakeLiteLLM().withModel({ modelName: "qwen3.8" });
    expect(await listCatalog({ db: testDb, litellm })).toEqual([]);
  });

  test("un modèle enrichi et visible apparaît avec ses prix en euros par million de jetons", async () => {
    const litellm = new FakeLiteLLM().withModel({ modelName: "qwen3.8", inputCostPerToken: 0.0000004, outputCostPerToken: 0.0000027 });
    await saveCatalogEntry({ db: testDb, litellm }, admin, qwen);
    expect(await listCatalog({ db: testDb, litellm })).toEqual([
      {
        modelName: "qwen3.8",
        displayName: "Qwen 3.8 27B",
        description: "Modèle généraliste hébergé par OVHcloud",
        useCases: "Synthèse de documents confidentiels",
        category: "texte",
        provider: "openai",
        dataLevel: "N3",
        hosting: "UE",
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
      { modelName: "qwen3.8", hasEuroPricing: true, entry: { displayName: "Qwen 3.8 27B", dataLevel: "N3", visible: true } },
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
