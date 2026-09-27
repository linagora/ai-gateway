import { beforeEach, describe, expect, test } from "vitest";
import { resetDb, testDb } from "@/test/db";
import { FakeLiteLLM } from "@/test/fake-litellm";
import { approveKeyRequest, requestCompletion } from "./admin-requests";
import { listAudit } from "./audit";
import { saveCatalogEntry } from "./catalog";
import { pickUpKey, replaceKey, revokeKey } from "./keys";
import { cancelRequest, completeRequest, createKeyRequest, createTeamJoinRequest, type KeyRequestInput } from "./requests";
import { saveSettings } from "./settings";

/*
 * Canal (spécification #71, ticket #73) : quand l'acteur agit par une intégration, les services inscrivent son canal
 * dans les détails de leurs entrées du journal d'audit ; les actions du portail (acteur sans canal) n'en portent pas.
 */
const admin = { uid: "jdupont", email: "jdupont@linagora.com", name: "Jeanne Dupont", isAdmin: true };
const membre = { uid: "pmartin", email: "pmartin@linagora.com", name: "Paul Martin", isAdmin: false };
const parTeamManager = { ...membre, canal: "team-manager" };

let deps: { db: typeof testDb; litellm: FakeLiteLLM };

beforeEach(async () => {
  await resetDb();
  const litellm = new FakeLiteLLM()
    .withModel({ modelName: "mistral-small" })
    .withTeam({ teamId: "equipe-rd", teamAlias: "R&D", models: [], memberUids: ["pmartin"] })
    .withTeam({ teamId: "equipe-data", teamAlias: "Data", models: [], memberUids: [] });
  deps = { db: testDb, litellm };
  await saveCatalogEntry(deps, admin, {
    modelName: "mistral-small", displayNameFr: "Mistral Small", shortDescriptionFr: "…", longDescriptionFr: "…", useCases: [], recommendedFor: [], dataLevel: "N2", visible: true,
  });
  await saveSettings(deps, admin, { pickup_days: "14" });
});

const demande: KeyRequestInput = {
  teamId: "equipe-rd", dataLevel: "N2", models: ["mistral-small"], justification: "Assistant de rédaction", project: null, requestedBudget: null, requestedDays: 90, commitment: true,
};
const parametres = { models: ["mistral-small"], budget: 15, budgetDuration: "30d", days: 60, rpmLimit: null, tpmLimit: null };

/** Entrées du journal d'audit de l'acteur, sans l'action de l'admin : [action, canal]. */
const journal = async () => (await listAudit(testDb)).filter((e) => e.actorUid === membre.uid).map((e) => [e.action, e.details.canal ?? null]);

describe("canal des actions d'un collaborateur", () => {
  test("par une intégration, une demande de clé, une demande d'accès à une équipe, un complément et une annulation inscrivent le canal au journal", async () => {
    const { id } = await createKeyRequest(deps, parTeamManager, demande);
    await requestCompletion(deps, admin, id, "Précisez le projet");
    await completeRequest(deps, parTeamManager, id, { ...demande, project: "Compte-rendu hebdo" });
    await cancelRequest(deps, parTeamManager, id);
    await createTeamJoinRequest(deps, parTeamManager, { teamId: "equipe-data", justification: "Rejoindre Data" });
    expect(await journal()).toEqual([
      ["REQUEST_CREATED", "team-manager"],
      ["REQUEST_COMPLETED", "team-manager"],
      ["REQUEST_CANCELLED", "team-manager"],
      ["REQUEST_CREATED", "team-manager"],
    ]);
  });

  test("par une intégration, le retrait, le remplacement et la révocation d'une clé inscrivent le canal au journal", async () => {
    const { id } = await createKeyRequest(deps, membre, demande);
    await approveKeyRequest(deps, admin, id, parametres);
    await pickUpKey(deps, parTeamManager, id);
    await replaceKey(deps, parTeamManager, id);
    await revokeKey(deps, parTeamManager, id);
    expect(await journal()).toEqual([
      ["REQUEST_CREATED", null],
      ["KEY_GENERATED", "team-manager"],
      ["KEY_REPLACED", "team-manager"],
      ["KEY_REVOKED", "team-manager"],
    ]);
  });

  test("depuis le portail, les mêmes actions n'inscrivent aucun canal ; le complément et l'annulation sont désormais au journal", async () => {
    const { id } = await createKeyRequest(deps, membre, demande);
    await requestCompletion(deps, admin, id, "Précisez le projet");
    await completeRequest(deps, membre, id, { ...demande, project: "Compte-rendu hebdo" });
    await cancelRequest(deps, membre, id);
    expect(await journal()).toEqual([
      ["REQUEST_CREATED", null],
      ["REQUEST_COMPLETED", null],
      ["REQUEST_CANCELLED", null],
    ]);
    expect((await listAudit(testDb)).every((e) => !("canal" in e.details))).toBe(true);
  });
});
