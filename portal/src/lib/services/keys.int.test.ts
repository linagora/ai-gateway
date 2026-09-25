import { beforeEach, describe, expect, test } from "vitest";
import { resetDb, testDb } from "@/test/db";
import { FakeLiteLLM } from "@/test/fake-litellm";
import { approveKeyRequest } from "./admin-requests";
import { listAudit } from "./audit";
import { saveCatalogEntry } from "./catalog";
import { listMyKeys, pickUpKey } from "./keys";
import { createKeyRequest, type KeyRequestInput } from "./requests";
import { saveSettings } from "./settings";

const admin = { uid: "jdupont", email: "jdupont@linagora.com", name: "Jeanne Dupont", isAdmin: true };
const titulaire = { uid: "mmaudet", email: "mmaudet@linagora.com", name: "Michel-Marie Maudet", isAdmin: false };
const collegue = { uid: "pmartin", email: "pmartin@linagora.com", name: "Paul Martin", isAdmin: false };

const JOUR = 86_400_000;
/** Date du jour injectée : approbation le 1er octobre 2026 à 9 h (UTC). */
let maintenant = new Date("2026-10-01T09:00:00Z");

let litellm: FakeLiteLLM;
let deps: { db: typeof testDb; litellm: FakeLiteLLM; now: () => Date };

beforeEach(async () => {
  await resetDb();
  maintenant = new Date("2026-10-01T09:00:00Z");
  litellm = new FakeLiteLLM()
    .withModel({ modelName: "mistral-small" })
    .withModel({ modelName: "qwen3.8" })
    .withTeam({ teamId: "equipe-rd", teamAlias: "R&D", models: [], memberUids: ["mmaudet", "pmartin"] });
  litellm.horloge = () => maintenant;
  deps = { db: testDb, litellm, now: () => maintenant };
  const fiche = { shortDescriptionFr: "…", longDescriptionFr: "…", useCases: [], recommendedFor: [], visible: true };
  await saveCatalogEntry(deps, admin, { ...fiche, modelName: "mistral-small", displayNameFr: "Mistral Small", dataLevel: "N2" });
  await saveCatalogEntry(deps, admin, { ...fiche, modelName: "qwen3.8", displayNameFr: "Qwen 3.8", dataLevel: "N3" });
  await saveSettings(deps, admin, { pickup_days: "14" });
});

const demande: KeyRequestInput = {
  teamId: "equipe-rd",
  dataLevel: "N2",
  models: ["mistral-small"],
  justification: "Assistant de rédaction",
  project: "Compte-rendu hebdo",
  requestedBudget: 20,
  requestedDays: 90,
  keyType: "PERSONNELLE",
  commitment: true,
};

/** Demande approuvée avec des paramètres de clé connus. */
async function demandeApprouvee(input: Partial<KeyRequestInput> = {}): Promise<string> {
  const { id } = await createKeyRequest(deps, titulaire, { ...demande, ...input });
  await approveKeyRequest(deps, admin, id, { models: ["mistral-small"], budget: 15, budgetDuration: "30d", days: 60, rpmLimit: 100, tpmLimit: null });
  return id;
}

describe("retrait d'une clé (ticket #15)", () => {
  test("le retrait génère une clé aux paramètres approuvés, valable à partir du retrait, et passe la demande en clé émise", async () => {
    const id = await demandeApprouvee();
    maintenant = new Date("2026-10-03T14:00:00Z");
    const { key } = await pickUpKey(deps, titulaire, id);

    const generee = [...litellm.keys.values()].find((k) => k.key === key);
    expect(generee).toMatchObject({
      userId: "mmaudet",
      teamId: "equipe-rd",
      models: ["mistral-small"],
      maxBudget: 15,
      budgetDuration: "30d",
      duration: "60d",
      rpmLimit: 100,
      tpmLimit: null,
      alias: `mmaudet-r-d-compte-rendu-hebdo-${id.slice(-4)}`,
      metadata: { request_id: id, project: "Compte-rendu hebdo", data_level: "N2", approved_by: "jdupont", key_type: "PERSONNELLE" },
    });
    expect((await listMyKeys(deps, titulaire)).keys).toEqual([
      expect.objectContaining({
        requestId: id,
        alias: `mmaudet-r-d-compte-rendu-hebdo-${id.slice(-4)}`,
        teamAlias: "R&D",
        dataLevel: "N2",
        models: ["mistral-small"],
        issuedAt: new Date("2026-10-03T14:00:00Z"),
        expiresAt: new Date(new Date("2026-10-03T14:00:00Z").getTime() + 60 * JOUR),
        status: "CLE_EMISE",
      }),
    ]);
  });

  test("« Mes clés » présente les demandes approuvées à retirer avec leur échéance de retrait", async () => {
    const id = await demandeApprouvee();
    expect(await listMyKeys(deps, titulaire)).toEqual({
      toPickUp: [expect.objectContaining({ requestId: id, teamAlias: "R&D", dataLevel: "N2", models: ["mistral-small"], pickupDeadline: new Date("2026-10-15T09:00:00Z") })],
      keys: [],
    });
    expect(await listMyKeys(deps, collegue)).toEqual({ toPickUp: [], keys: [] });
  });

  test("sans projet, l'alias porte « cle » ; il reste sans espaces ni accents", async () => {
    const id = await demandeApprouvee({ project: null });
    const { key } = await pickUpKey(deps, titulaire, id);
    expect([...litellm.keys.values()].find((k) => k.key === key)?.alias).toBe(`mmaudet-r-d-cle-${id.slice(-4)}`);
  });

  test("la clé n'est conservée ni sur la demande ni au journal d'audit, qui inscrit le retrait", async () => {
    const id = await demandeApprouvee();
    const { key } = await pickUpKey(deps, titulaire, id);
    const conserve = JSON.stringify([await testDb.accessRequest.findMany(), await listAudit(testDb)], (_, v) => (typeof v === "bigint" ? String(v) : v));
    expect(conserve).not.toContain(key);
    expect((await listAudit(testDb)).map((e) => [e.actorUid, e.action, e.targetId])).toContainEqual(["mmaudet", "KEY_GENERATED", id]);
  });

  test("un salarié ne retire que ses propres demandes approuvées, et une seule fois", async () => {
    const id = await demandeApprouvee();
    await expect(pickUpKey(deps, collegue, id)).rejects.toMatchObject({ code: "introuvable" });
    const { id: soumise } = await createKeyRequest(deps, titulaire, demande);
    await expect(pickUpKey(deps, titulaire, soumise)).rejects.toMatchObject({ code: "transition_interdite" });
    await pickUpKey(deps, titulaire, id);
    await expect(pickUpKey(deps, titulaire, id)).rejects.toMatchObject({ code: "transition_interdite" });
  });

  test("une passerelle injoignable laisse la demande à retirer", async () => {
    const id = await demandeApprouvee();
    litellm.panne = true;
    await expect(pickUpKey(deps, titulaire, id)).rejects.toMatchObject({ code: "passerelle_indisponible" });
    expect((await listMyKeys(deps, titulaire)).toPickUp.map((d) => d.requestId)).toEqual([id]);
  });
});

describe("dépense, budget et exemple d'appel dans « Mes clés » (ticket #16)", () => {
  test("chaque clé émise montre sa dépense, son budget, la remise à zéro et son état bloqué, lus dans la passerelle", async () => {
    const id = await demandeApprouvee();
    const { key } = await pickUpKey(deps, titulaire, id);
    const generee = [...litellm.keys.values()].find((k) => k.key === key)!;
    generee.spend = 2.5;
    expect((await listMyKeys(deps, titulaire)).keys[0].usage).toEqual({
      spend: 2.5,
      maxBudget: 15,
      budgetResetAt: new Date(maintenant.getTime() + 30 * JOUR),
      blocked: false,
    });
  });

  test("une passerelle injoignable n'empêche pas « Mes clés » : seules les valeurs lues dans la passerelle manquent", async () => {
    const id = await demandeApprouvee();
    await pickUpKey(deps, titulaire, id);
    litellm.panne = true;
    expect((await listMyKeys(deps, titulaire)).keys).toEqual([expect.objectContaining({ requestId: id, usage: null })]);
  });

  test("l'exemple d'appel d'une clé porte son premier modèle et le type d'API de celui-ci", async () => {
    litellm.withModel({ modelName: "jev-latest", apiKind: "decision" });
    const fiche = { shortDescriptionFr: "…", longDescriptionFr: "…", useCases: [], recommendedFor: [], visible: true };
    await saveCatalogEntry(deps, admin, { ...fiche, modelName: "jev-latest", displayNameFr: "JEV", dataLevel: "EXP" });
    const { id } = await createKeyRequest(deps, titulaire, { ...demande, dataLevel: "EXP", models: ["jev-latest"] });
    await approveKeyRequest(deps, admin, id, { models: ["jev-latest"], budget: 5, budgetDuration: "30d", days: 30, rpmLimit: null, tpmLimit: null });
    await pickUpKey(deps, titulaire, id);
    const idConversation = await demandeApprouvee();
    await pickUpKey(deps, titulaire, idConversation);
    expect(Object.fromEntries((await listMyKeys(deps, titulaire)).keys.map((k) => [k.requestId, k.example]))).toEqual({
      [id]: { model: "jev-latest", apiKind: "decision" },
      [idConversation]: { model: "mistral-small", apiKind: "conversation" },
    });
  });
});
