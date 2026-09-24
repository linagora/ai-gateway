import { beforeEach, describe, expect, test } from "vitest";
import { resetDb, testDb } from "@/test/db";
import { FakeLiteLLM } from "@/test/fake-litellm";
import { approveKeyRequest, getRequestReview, listPendingRequests } from "./admin-requests";
import { saveCatalogEntry } from "./catalog";
import { createKeyRequest, type KeyRequestInput } from "./requests";
import { saveSettings } from "./settings";

const admin = { uid: "jdupont", email: "jdupont@linagora.com", name: "Jeanne Dupont", isAdmin: true };
const demandeur = { uid: "mmaudet", email: "mmaudet@linagora.com", name: "Michel-Marie Maudet", isAdmin: false };
const collegue = { uid: "pmartin", email: "pmartin@linagora.com", name: "Paul Martin", isAdmin: false };

let litellm: FakeLiteLLM;
let deps: { db: typeof testDb; litellm: FakeLiteLLM };

beforeEach(async () => {
  await resetDb();
  litellm = new FakeLiteLLM()
    .withModel({ modelName: "mistral-small" })
    .withModel({ modelName: "qwen3.8" })
    .withTeam({ teamId: "equipe-rd", teamAlias: "R&D", models: ["mistral-small", "qwen3.8"], memberUids: ["mmaudet", "pmartin"] });
  deps = { db: testDb, litellm };
  const entry = { description: "…", useCases: null, category: "texte", hosting: "UE" as const, visible: true };
  await saveCatalogEntry(deps, admin, { ...entry, modelName: "mistral-small", displayName: "Mistral Small", dataLevel: "N2" });
  await saveCatalogEntry(deps, admin, { ...entry, modelName: "qwen3.8", displayName: "Qwen 3.8", dataLevel: "N3" });
});

const demande: KeyRequestInput = {
  teamId: "equipe-rd",
  dataLevel: "N2",
  models: ["mistral-small", "qwen3.8"],
  justification: "Assistant de rédaction",
  project: "compte-rendu",
  requestedBudget: 20,
  requestedDays: 90,
  keyType: "PERSONNELLE",
  commitment: true,
};

describe("file de validation (F-30)", () => {
  test("les demandes soumises sont présentées de la plus ancienne à la plus récente", async () => {
    const premiere = await createKeyRequest(deps, demandeur, demande);
    const seconde = await createKeyRequest(deps, collegue, { ...demande, project: "veille" });
    expect((await listPendingRequests(deps, admin)).map((r) => r.id)).toEqual([premiere.id, seconde.id]);
  });

  test("un salarié n'accède pas à la file de validation", async () => {
    await expect(listPendingRequests(deps, demandeur)).rejects.toMatchObject({ code: "interdit" });
  });
});

describe("fiche de validation (F-32)", () => {
  test("les contrôles sont rejoués avec l'état actuel du catalogue", async () => {
    const { id } = await createKeyRequest(deps, demandeur, demande);
    const entry = { description: "…", useCases: null, category: "texte", hosting: "UE" as const };
    await saveCatalogEntry(deps, admin, { ...entry, modelName: "qwen3.8", displayName: "Qwen 3.8", dataLevel: "N3", visible: false });
    const review = await getRequestReview(deps, admin, id);
    expect(review.checks.filter((c) => !c.ok)).toEqual([{ id: "modeles_visibles", ok: false, offending: ["qwen3.8"] }]);
  });
});

const parametres = { models: ["mistral-small"], budget: 15, budgetDuration: "30d", days: 60, rpmLimit: null, tpmLimit: null };

describe("approbation (F-31)", () => {
  test("approuver fige les paramètres de la clé et passe la demande à APPROUVEE", async () => {
    const { id } = await createKeyRequest(deps, demandeur, demande);
    await approveKeyRequest(deps, admin, id, parametres);
    expect(await getRequestReview(deps, admin, id)).toMatchObject({
      status: "APPROUVEE",
      decidedBy: "jdupont",
      approved: { models: ["mistral-small"], budget: 15, budgetDuration: "30d", days: 60, rpmLimit: null, tpmLimit: null },
    });
  });

  test("règle 4 : les contrôles sont rejoués avec les modèles modifiés par l'admin", async () => {
    const { id } = await createKeyRequest(deps, demandeur, { ...demande, dataLevel: "N3", models: ["qwen3.8"] });
    await expect(approveKeyRequest(deps, admin, id, { ...parametres, models: ["qwen3.8", "mistral-small"] })).rejects.toMatchObject({
      code: "controles_en_echec",
      failedChecks: [{ id: "niveau_modeles", ok: false, offending: ["mistral-small"] }],
    });
  });

  test("règle 7 : sans réglage par défaut, un budget non saisi bloque l'approbation", async () => {
    const { id } = await createKeyRequest(deps, demandeur, demande);
    await expect(approveKeyRequest(deps, admin, id, { ...parametres, budget: null })).rejects.toMatchObject({ code: "parametre_manquant" });
  });

  test("règle 7 : les réglages par défaut (F-51) complètent les paramètres non saisis", async () => {
    await saveSettings(deps, admin, { default_budget: "25", default_budget_duration: "30d", default_days: "90" });
    const { id } = await createKeyRequest(deps, demandeur, demande);
    await approveKeyRequest(deps, admin, id, { ...parametres, budget: null, budgetDuration: null, days: null });
    expect((await getRequestReview(deps, admin, id)).approved).toMatchObject({ budget: 25, budgetDuration: "30d", days: 90 });
  });
});
