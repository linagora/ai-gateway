import { beforeEach, describe, expect, test } from "vitest";
import { resetDb, testDb } from "@/test/db";
import { FakeLiteLLM } from "@/test/fake-litellm";
import { saveCatalogEntry } from "./catalog";
import { cancelRequest, createKeyRequest, createTeamJoinRequest, type KeyRequestInput, listMyRequests } from "./requests";

const admin = { uid: "jdupont", email: "jdupont@linagora.com", name: "Jeanne Dupont", isAdmin: true };
const demandeur = { uid: "mmaudet", email: "mmaudet@linagora.com", name: "Michel-Marie Maudet", isAdmin: false };

let litellm: FakeLiteLLM;
let deps: { db: typeof testDb; litellm: FakeLiteLLM };

beforeEach(async () => {
  await resetDb();
  litellm = new FakeLiteLLM()
    .withModel({ modelName: "mistral-small" })
    .withModel({ modelName: "qwen3.8" })
    .withTeam({ teamId: "equipe-rd", teamAlias: "R&D", models: ["mistral-small", "qwen3.8"], memberUids: ["mmaudet"] });
  deps = { db: testDb, litellm };
  const entry = { description: "…", useCases: null, category: "texte", hosting: "UE" as const, visible: true };
  await saveCatalogEntry(deps, admin, { ...entry, modelName: "mistral-small", displayName: "Mistral Small", dataLevel: "N2" });
  await saveCatalogEntry(deps, admin, { ...entry, modelName: "qwen3.8", displayName: "Qwen 3.8", dataLevel: "N3" });
});

const demande: KeyRequestInput = {
  teamId: "equipe-rd",
  dataLevel: "N2",
  models: ["mistral-small", "qwen3.8"],
  justification: "Assistant de rédaction des comptes rendus",
  project: "compte-rendu",
  requestedBudget: 20,
  requestedDays: 90,
  keyType: "PERSONNELLE",
  commitment: true,
};

describe("demandes de clé (F-20 à F-24)", () => {
  test("une demande conforme est enregistrée au statut SOUMISE et apparaît dans Mes demandes", async () => {
    await createKeyRequest(deps, demandeur, demande);
    expect(await listMyRequests(deps, demandeur)).toMatchObject([
      { kind: "CLE", teamAlias: "R&D", dataLevel: "N2", models: ["mistral-small", "qwen3.8"], status: "SOUMISE" },
    ]);
  });

  test("sans l'engagement sur le niveau des données (F-21), la demande est refusée", async () => {
    await expect(createKeyRequest(deps, demandeur, { ...demande, commitment: false })).rejects.toMatchObject({ code: "engagement_requis" });
  });

  test("critère 5 : une demande N3 incluant un modèle N2 est refusée côté serveur, contrôle en échec à l'appui", async () => {
    await expect(createKeyRequest(deps, demandeur, { ...demande, dataLevel: "N3" })).rejects.toMatchObject({
      code: "controles_en_echec",
      failedChecks: [{ id: "niveau_modeles", ok: false, offending: ["mistral-small"] }],
    });
  });

  test("une demande pour une équipe inconnue est refusée", async () => {
    await expect(createKeyRequest(deps, demandeur, { ...demande, teamId: "equipe-fantome" })).rejects.toMatchObject({ code: "introuvable" });
  });

  test("un utilisateur ne voit pas les demandes des autres", async () => {
    await createKeyRequest(deps, demandeur, demande);
    expect(await listMyRequests(deps, { ...demandeur, uid: "pmartin", email: "pmartin@linagora.com" })).toEqual([]);
  });
});

describe("demandes d'adhésion à une équipe (F-22)", () => {
  beforeEach(() => {
    litellm.withTeam({ teamId: "equipe-data", teamAlias: "Data", models: ["mistral-small"], memberUids: ["jdupont"] });
  });

  test("une demande d'adhésion est enregistrée et apparaît dans Mes demandes", async () => {
    await createTeamJoinRequest(deps, demandeur, { teamId: "equipe-data", justification: "Rejoindre le projet d'analyse" });
    expect(await listMyRequests(deps, demandeur)).toMatchObject([{ kind: "ADHESION_EQUIPE", teamAlias: "Data", status: "SOUMISE" }]);
  });

  test("un membre de l'équipe ne peut pas demander à la rejoindre", async () => {
    await expect(createTeamJoinRequest(deps, demandeur, { teamId: "equipe-rd", justification: "…" })).rejects.toMatchObject({ code: "deja_membre" });
  });
});

describe("annulation par le demandeur (F-24)", () => {
  test("le demandeur annule sa demande soumise", async () => {
    const { id } = await createKeyRequest(deps, demandeur, demande);
    await cancelRequest(deps, demandeur, id);
    expect(await listMyRequests(deps, demandeur)).toMatchObject([{ id, status: "ANNULEE" }]);
  });

  test("une demande annulée ne peut pas l'être une seconde fois", async () => {
    const { id } = await createKeyRequest(deps, demandeur, demande);
    await cancelRequest(deps, demandeur, id);
    await expect(cancelRequest(deps, demandeur, id)).rejects.toMatchObject({ code: "transition_interdite" });
  });

  test("un autre utilisateur ne peut pas annuler la demande", async () => {
    const { id } = await createKeyRequest(deps, demandeur, demande);
    const autre = { ...demandeur, uid: "pmartin", email: "pmartin@linagora.com" };
    await expect(cancelRequest(deps, autre, id)).rejects.toMatchObject({ code: "introuvable" });
  });
});
