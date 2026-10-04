import { beforeEach, describe, expect, test } from "vitest";
import { SANS_EXPIRATION } from "@/lib/durees";
import { LimiteDeDebit } from "@/lib/limite-de-debit";
import { resetDb, testDb } from "@/test/db";
import { FakeLiteLLM } from "@/test/fake-litellm";
import { FakeMailer } from "@/test/fake-mailer";
import { approveKeyRequest, getRequestReview, refuseRequest, requestCompletion } from "./admin-requests";
import { listAudit } from "./audit";
import { saveCatalogEntry } from "./catalog";
import { runDailyTask } from "./echeances";
import { blockKey, listActiveKeys, listKeyArchive, listKeysToPickUp, listMyKeys, pickUpKey, renewalDraft, replaceKey, revokeKey, revokeOwnKey, unblockKey } from "./keys";
import { completeRequest, createKeyRequest, type KeyRequestInput, listMyRequests } from "./requests";
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
      metadata: { request_id: id, project: "Compte-rendu hebdo", data_level: "N2", approved_by: "jdupont" },
    });
    expect(generee?.metadata).not.toHaveProperty("key_type");
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
    expect((await listMyKeys(deps, titulaire)).keys[0].gatewayState).toEqual({
      spend: 2.5,
      maxBudget: 15,
      budgetResetAt: new Date(maintenant.getTime() + 30 * JOUR),
      blocked: false,
    });
  });

  test("« Mes clés » présente les clés actives d'abord, puis les révoquées ou expirées, les plus récentes en premier", async () => {
    const retirer = async (projet: string, heures: number) => {
      const id = await demandeApprouvee({ project: projet });
      maintenant = new Date(Date.parse("2026-10-01T09:00:00Z") + heures * 3_600_000);
      await pickUpKey(deps, titulaire, id);
      return id;
    };
    const ancienne = await retirer("Ancienne", 1);
    await revokeKey(deps, titulaire, ancienne);
    const active1 = await retirer("Active un", 2);
    const revoquee = await retirer("Révoquée", 3);
    await revokeKey(deps, titulaire, revoquee);
    const active2 = await retirer("Active deux", 4);
    expect((await listMyKeys(deps, titulaire)).keys.map((k) => k.requestId)).toEqual([active2, active1, revoquee, ancienne]);
  });

  test("une passerelle injoignable n'empêche pas « Mes clés » : seules les valeurs lues dans la passerelle manquent", async () => {
    const id = await demandeApprouvee();
    await pickUpKey(deps, titulaire, id);
    litellm.panne = true;
    expect((await listMyKeys(deps, titulaire)).keys).toEqual([expect.objectContaining({ requestId: id, gatewayState: null })]);
  });

  test("les exemples d'appel d'une clé : un par type d'API qu'elle porte, avec le premier modèle de ce type", async () => {
    litellm.withModel({ modelName: "glm-beta" }).withModel({ modelName: "jev-latest", apiKind: "decision" });
    const fiche = { shortDescriptionFr: "…", longDescriptionFr: "…", useCases: [], recommendedFor: [], visible: true };
    await saveCatalogEntry(deps, admin, { ...fiche, modelName: "glm-beta", displayNameFr: "GLM bêta", dataLevel: "EXP" });
    await saveCatalogEntry(deps, admin, { ...fiche, modelName: "jev-latest", displayNameFr: "JEV", dataLevel: "EXP" });
    const modeles = ["glm-beta", "jev-latest"];
    const { id } = await createKeyRequest(deps, titulaire, { ...demande, dataLevel: "EXP", models: modeles });
    await approveKeyRequest(deps, admin, id, { models: modeles, budget: 5, budgetDuration: "30d", days: 30, rpmLimit: null, tpmLimit: null });
    await pickUpKey(deps, titulaire, id);
    const idConversation = await demandeApprouvee();
    await pickUpKey(deps, titulaire, idConversation);
    expect(Object.fromEntries((await listMyKeys(deps, titulaire)).keys.map((k) => [k.requestId, k.examples]))).toEqual({
      [id]: [
        { model: "glm-beta", apiKind: "conversation" },
        { model: "jev-latest", apiKind: "decision" },
      ],
      [idConversation]: [{ model: "mistral-small", apiKind: "conversation" }],
    });
  });

  test("une clé qui contient un modèle d'embeddings reçoit un exemple d'appel de ce type, à côté de celui de ses modèles de conversation (ticket #127)", async () => {
    litellm.withModel({ modelName: "bge-m3", apiKind: "embeddings", dimensions: 1024 });
    await saveCatalogEntry(deps, admin, { shortDescriptionFr: "…", longDescriptionFr: "…", useCases: [], recommendedFor: [], visible: true, modelName: "bge-m3", displayNameFr: "BGE-M3", dataLevel: "N3" });
    const modeles = ["mistral-small", "bge-m3"];
    const { id } = await createKeyRequest(deps, titulaire, { ...demande, models: modeles });
    await approveKeyRequest(deps, admin, id, { models: modeles, budget: 5, budgetDuration: "30d", days: 30, rpmLimit: null, tpmLimit: null });
    await pickUpKey(deps, titulaire, id);
    expect((await listMyKeys(deps, titulaire)).keys[0].examples).toEqual([
      { model: "mistral-small", apiKind: "conversation" },
      { model: "bge-m3", apiKind: "embeddings" },
    ]);
  });
});

describe("révocation par le titulaire (ticket #17)", () => {
  test("le titulaire révoque sa clé : elle est supprimée de la passerelle et la demande passe en « Révoquée »", async () => {
    const id = await demandeApprouvee();
    const { key } = await pickUpKey(deps, titulaire, id);
    await revokeKey(deps, titulaire, id);
    expect([...litellm.keys.values()].some((k) => k.key === key)).toBe(false);
    expect((await listMyKeys(deps, titulaire)).keys).toEqual([expect.objectContaining({ requestId: id, status: "REVOQUEE", gatewayState: null })]);
    expect((await listAudit(testDb)).map((e) => [e.actorUid, e.action, e.targetId])).toContainEqual(["mmaudet", "KEY_REVOKED", id]);
  });

  test("un salarié ne révoque que ses propres clés, et une seule fois", async () => {
    const id = await demandeApprouvee();
    await pickUpKey(deps, titulaire, id);
    await expect(revokeKey(deps, collegue, id)).rejects.toMatchObject({ code: "introuvable" });
    await revokeKey(deps, titulaire, id);
    await expect(revokeKey(deps, titulaire, id)).rejects.toMatchObject({ code: "transition_interdite" });
  });

  test("une clé déjà supprimée dans la passerelle (depuis la console) est marquée « Révoquée »", async () => {
    const id = await demandeApprouvee();
    await pickUpKey(deps, titulaire, id);
    litellm.keys.clear();
    await revokeKey(deps, titulaire, id);
    expect((await listMyKeys(deps, titulaire)).keys[0].status).toBe("REVOQUEE");
  });

  test("une passerelle injoignable laisse la clé émise", async () => {
    const id = await demandeApprouvee();
    await pickUpKey(deps, titulaire, id);
    litellm.panne = true;
    await expect(revokeKey(deps, titulaire, id)).rejects.toMatchObject({ code: "passerelle_indisponible" });
    litellm.panne = false;
    expect((await listMyKeys(deps, titulaire)).keys[0].status).toBe("CLE_EMISE");
  });
});

describe("remplacement d'une clé perdue (ticket #18)", () => {
  test("la nouvelle clé garde les paramètres et la date d'expiration de l'ancienne, qui est supprimée ; l'alias porte le rang du remplacement", async () => {
    const id = await demandeApprouvee();
    const { key: ancienne } = await pickUpKey(deps, titulaire, id);
    const expiration = new Date(maintenant.getTime() + 60 * JOUR);
    maintenant = new Date(maintenant.getTime() + 10 * JOUR);

    const { key: nouvelle, alias } = await replaceKey(deps, titulaire, id);
    expect(alias).toBe(`mmaudet-r-d-compte-rendu-hebdo-${id.slice(-4)}-2`);
    expect(nouvelle).not.toBe(ancienne);
    expect([...litellm.keys.values()].map((k) => k.key)).toEqual([nouvelle]);
    expect([...litellm.keys.values()][0]).toMatchObject({ models: ["mistral-small"], maxBudget: 15, budgetDuration: "30d", rpmLimit: 100, expiresAt: expiration });
    expect((await listMyKeys(deps, titulaire)).keys).toEqual([expect.objectContaining({ alias, expiresAt: expiration, status: "CLE_EMISE" })]);

    expect((await replaceKey(deps, titulaire, id)).alias).toBe(`mmaudet-r-d-compte-rendu-hebdo-${id.slice(-4)}-3`);
  });

  test("le remplacement reprend la dépense de l'ancienne clé : il ne remet pas le budget à zéro", async () => {
    const id = await demandeApprouvee();
    const { key: ancienne } = await pickUpKey(deps, titulaire, id);
    [...litellm.keys.values()].find((k) => k.key === ancienne)!.spend = 12.5;
    const { key: nouvelle } = await replaceKey(deps, titulaire, id);
    expect([...litellm.keys.values()].find((k) => k.key === nouvelle)?.spend).toBe(12.5);
  });

  test("le remplacement est refusé sur une clé révoquée, sur une clé expirée, et sur la clé d'un autre salarié", async () => {
    const revoquee = await demandeApprouvee();
    await pickUpKey(deps, titulaire, revoquee);
    await revokeKey(deps, titulaire, revoquee);
    await expect(replaceKey(deps, titulaire, revoquee)).rejects.toMatchObject({ code: "transition_interdite" });

    const expiree = await demandeApprouvee();
    await pickUpKey(deps, titulaire, expiree);
    await expect(replaceKey(deps, collegue, expiree)).rejects.toMatchObject({ code: "introuvable" });
    maintenant = new Date(maintenant.getTime() + 61 * JOUR);
    await expect(replaceKey(deps, titulaire, expiree)).rejects.toMatchObject({ code: "transition_interdite", params: { cas: "expiree" } });
  });

  test("si l'ancienne clé ne peut pas être supprimée, la nouvelle est retirée et rien ne change", async () => {
    const id = await demandeApprouvee();
    const { key: ancienne } = await pickUpKey(deps, titulaire, id);
    litellm.indestructibles.add([...litellm.keys.values()].find((k) => k.key === ancienne)!.tokenId);
    await expect(replaceKey(deps, titulaire, id)).rejects.toMatchObject({ code: "passerelle_indisponible" });
    expect([...litellm.keys.values()].map((k) => k.key)).toEqual([ancienne]);
    expect((await listMyKeys(deps, titulaire)).keys[0].alias).toBe(`mmaudet-r-d-compte-rendu-hebdo-${id.slice(-4)}`);
  });

  test("le remplacement est inscrit au journal d'audit, sans clé", async () => {
    const id = await demandeApprouvee();
    await pickUpKey(deps, titulaire, id);
    const { key } = await replaceKey(deps, titulaire, id);
    const journal = await listAudit(testDb);
    expect(journal.map((e) => [e.actorUid, e.action, e.targetId])).toContainEqual(["mmaudet", "KEY_REPLACED", id]);
    expect(JSON.stringify(journal)).not.toContain(key);
  });
});

describe("« Gestion — Clés » et révocation par un admin (ticket #19)", () => {
  test("la liste des admins donne toutes les clés émises, avec titulaire, équipe, niveau, alias, dépense sur budget et expiration", async () => {
    const id = await demandeApprouvee();
    const { key } = await pickUpKey(deps, titulaire, id);
    [...litellm.keys.values()].find((k) => k.key === key)!.spend = 1.25;
    const { id: idCollegue } = await createKeyRequest(deps, collegue, demande);
    await approveKeyRequest(deps, admin, idCollegue, { models: ["mistral-small"], budget: 10, budgetDuration: "30d", days: 30, rpmLimit: null, tpmLimit: null });
    await pickUpKey(deps, collegue, idCollegue);

    const cles = await listActiveKeys(deps, admin);
    expect(cles).toHaveLength(2);
    expect(cles.find((k) => k.requestId === id)).toMatchObject({
      holderUid: "mmaudet",
      holderEmail: "mmaudet@linagora.com",
      teamAlias: "R&D",
      dataLevel: "N2",
      alias: `mmaudet-r-d-compte-rendu-hebdo-${id.slice(-4)}`,
      status: "CLE_EMISE",
      expiresAt: new Date(maintenant.getTime() + 60 * JOUR),
      gatewayState: { spend: 1.25, maxBudget: 15, blocked: false },
    });
    expect(cles.find((k) => k.requestId === idCollegue)).toMatchObject({ holderUid: "pmartin", gatewayState: { spend: 0, maxBudget: 10 } });
  });

  test("les admins voient les clés approuvées qui attendent leur retrait, avec l'échéance de retrait", async () => {
    const id = await demandeApprouvee();
    const retiree = await demandeApprouvee({ project: "Déjà retirée" });
    await pickUpKey(deps, titulaire, retiree);
    expect(await listKeysToPickUp(deps, admin)).toEqual([
      expect.objectContaining({ requestId: id, holderUid: "mmaudet", teamAlias: "R&D", pickupDeadline: new Date("2026-10-15T09:00:00Z") }),
    ]);
    await expect(listKeysToPickUp(deps, titulaire)).rejects.toMatchObject({ code: "interdit" });
  });

  test("un salarié n'accède pas à la liste des clés", async () => {
    await expect(listActiveKeys(deps, titulaire)).rejects.toMatchObject({ code: "interdit" });
    await expect(listKeyArchive(deps, titulaire)).rejects.toMatchObject({ code: "interdit" });
  });

  test("l'archive des clés se lit par pages de 50, la plus récemment émise d'abord ; une page hors limites mène à la plus proche", async () => {
    expect(await listKeyArchive(deps, admin)).toEqual({ elements: [], page: 1, pages: 1, total: 0 });
    const debut = Date.parse("2026-06-01T08:00:00Z");
    await testDb.accessRequest.createMany({
      data: Array.from({ length: 60 }, (_, i) => ({
        kind: "CLE" as const, status: i % 2 ? ("REVOQUEE" as const) : ("EXPIREE" as const), requesterUid: `salarie-${i}`, requesterEmail: `salarie-${i}@linagora.com`,
        teamId: "equipe-rd", teamAlias: "R&D", dataLevel: "N2" as const, models: ["mistral-small"], approvedModels: ["mistral-small"], justification: "Essai",
        keyAlias: `cle-${i}`, keyIssuedAt: new Date(debut + i * JOUR),
      })),
    });
    const premiere = await listKeyArchive(deps, admin);
    expect(premiere).toMatchObject({ page: 1, pages: 2, total: 60 });
    expect(premiere.elements).toHaveLength(50);
    expect(premiere.elements.slice(0, 2).map((k) => k.alias)).toEqual(["cle-59", "cle-58"]);
    expect((await listKeyArchive(deps, admin, 2)).elements.map((k) => k.alias)).toEqual(Array.from({ length: 10 }, (_, i) => `cle-${9 - i}`));
    expect(await listKeyArchive(deps, admin, 99)).toMatchObject({ page: 2 });
    expect(await listActiveKeys(deps, admin)).toEqual([]);
  });

  test("filtrées sur une équipe, les listes ne gardent que ses clés à retirer, actives et archivées", async () => {
    const cle = (teamId: string, teamAlias: string, status: "APPROUVEE" | "CLE_EMISE" | "REVOQUEE", i: number) => ({
      kind: "CLE" as const, status, requesterUid: `salarie-${i}`, requesterEmail: `salarie-${i}@linagora.com`, teamId, teamAlias, dataLevel: "N2" as const,
      models: ["mistral-small"], approvedModels: ["mistral-small"], justification: "Essai", decidedAt: maintenant,
      ...(status === "APPROUVEE" ? {} : { keyAlias: `cle-${i}`, keyIssuedAt: maintenant }),
    });
    await testDb.accessRequest.createMany({
      data: [cle("equipe-rd", "R&D", "APPROUVEE", 1), cle("equipe-rd", "R&D", "CLE_EMISE", 2), cle("equipe-rd", "R&D", "REVOQUEE", 3), cle("equipe-data", "Data", "APPROUVEE", 4), cle("equipe-data", "Data", "CLE_EMISE", 5), cle("equipe-data", "Data", "REVOQUEE", 6)],
    });
    expect((await listKeysToPickUp(deps, admin, { equipe: "equipe-rd" })).map((k) => k.holderUid)).toEqual(["salarie-1"]);
    expect((await listActiveKeys(deps, admin, { equipe: "equipe-rd" })).map((k) => k.alias)).toEqual(["cle-2"]);
    expect((await listKeyArchive(deps, admin, 1, { equipe: "equipe-rd" })).elements.map((k) => k.alias)).toEqual(["cle-3"]);
    expect((await listActiveKeys(deps, admin)).map((k) => k.alias).sort()).toEqual(["cle-2", "cle-5"]);
  });

  test("un admin révoque la clé d'un salarié, avec le même effet ; le journal d'audit le nomme comme auteur", async () => {
    const id = await demandeApprouvee();
    const { key } = await pickUpKey(deps, titulaire, id);
    await revokeKey(deps, admin, id);
    expect([...litellm.keys.values()].some((k) => k.key === key)).toBe(false);
    expect((await listKeyArchive(deps, admin)).elements[0]).toMatchObject({ requestId: id, status: "REVOQUEE" });
    expect(await listActiveKeys(deps, admin)).toEqual([]);
    expect((await listAudit(testDb)).map((e) => [e.actorUid, e.action, e.targetId])).toContainEqual(["jdupont", "KEY_REVOKED", id]);
  });
});

describe("blocage et déblocage d'une clé (ticket #20)", () => {
  test("un admin bloque puis débloque une clé ; la demande reste « Clé émise » et l'état bloqué se voit dans « Mes clés »", async () => {
    const id = await demandeApprouvee();
    const { key } = await pickUpKey(deps, titulaire, id);
    await blockKey(deps, admin, id);
    expect([...litellm.keys.values()].find((k) => k.key === key)?.blocked).toBe(true);
    expect((await listMyKeys(deps, titulaire)).keys[0]).toMatchObject({ status: "CLE_EMISE", gatewayState: { blocked: true } });
    await unblockKey(deps, admin, id);
    expect((await listMyKeys(deps, titulaire)).keys[0]).toMatchObject({ status: "CLE_EMISE", gatewayState: { blocked: false } });
    expect((await listAudit(testDb)).filter((e) => e.actorUid === "jdupont").map((e) => [e.action, e.targetId])).toEqual([
      ["REQUEST_APPROVED", id],
      ["KEY_BLOCKED", id],
      ["KEY_UNBLOCKED", id],
    ]);
  });

  test("le blocage est réservé aux admins, sur une clé émise", async () => {
    const id = await demandeApprouvee();
    await pickUpKey(deps, titulaire, id);
    await expect(blockKey(deps, titulaire, id)).rejects.toMatchObject({ code: "interdit" });
    await revokeKey(deps, titulaire, id);
    await expect(blockKey(deps, admin, id)).rejects.toMatchObject({ code: "transition_interdite" });
  });

  test("une clé bloquée ne peut pas être remplacée", async () => {
    const id = await demandeApprouvee();
    await pickUpKey(deps, titulaire, id);
    await blockKey(deps, admin, id);
    await expect(replaceKey(deps, titulaire, id)).rejects.toMatchObject({ code: "transition_interdite", params: { cas: "bloquee" } });
    expect(litellm.keys.size).toBe(1);
  });
});

describe("renouvellement d'une clé (ticket #21)", () => {
  /** Clé émise, puis demande de renouvellement déposée avec le brouillon prérempli. */
  async function renouvellement(): Promise<{ origine: string; renouvelee: string; ancienne: string }> {
    const origine = await demandeApprouvee();
    const { key: ancienne } = await pickUpKey(deps, titulaire, origine);
    const brouillon = await renewalDraft(deps, titulaire, origine);
    const { id: renouvelee } = await createKeyRequest(deps, titulaire, { ...demande, ...brouillon, justification: "Renouvellement", commitment: true, renewsRequestId: origine });
    return { origine, renouvelee, ancienne };
  }

  test("« Renouveler » propose une demande préremplie avec les paramètres de la clé d'origine, à laquelle elle est reliée", async () => {
    const origine = await demandeApprouvee();
    await pickUpKey(deps, titulaire, origine);
    expect(await renewalDraft(deps, titulaire, origine)).toEqual({
      teamId: "equipe-rd",
      dataLevel: "N2",
      models: ["mistral-small"],
      project: "Compte-rendu hebdo",
      requestedBudget: 15,
      requestedDays: 60,
      alias: `mmaudet-r-d-compte-rendu-hebdo-${origine.slice(-4)}`,
    });
    const { renouvelee } = await renouvellement();
    expect((await listAudit(testDb)).map((e) => [e.action, e.targetId, e.details])).toContainEqual(["RENEWAL_REQUESTED", renouvelee, expect.objectContaining({ origine: expect.any(String) })]);
  });

  test("un renouvellement déposé sans budget reprend celui de la clé d'origine, qu'un complément garde", async () => {
    const origine = await demandeApprouvee();
    await pickUpKey(deps, titulaire, origine);
    const renouvellement = { ...demande, requestedBudget: null, justification: "Renouvellement", commitment: true };
    const { id } = await createKeyRequest(deps, titulaire, { ...renouvellement, renewsRequestId: origine });
    expect((await getRequestReview(deps, admin, id)).requestedBudget).toBe(15);
    await requestCompletion(deps, admin, id, "Précisez le projet");
    await completeRequest(deps, titulaire, id, { ...renouvellement, project: "Autre projet" });
    expect((await getRequestReview(deps, admin, id)).requestedBudget).toBe(15);
  });

  test("on ne renouvelle que ses propres clés : pas celle d'un autre, ni une demande sans clé", async () => {
    const origine = await demandeApprouvee();
    await expect(renewalDraft(deps, titulaire, origine)).rejects.toMatchObject({ code: "introuvable" });
    await pickUpKey(deps, titulaire, origine);
    await expect(renewalDraft(deps, collegue, origine)).rejects.toMatchObject({ code: "introuvable" });
    await expect(createKeyRequest(deps, collegue, { ...demande, renewsRequestId: origine })).rejects.toMatchObject({ code: "introuvable" });
  });

  test("la fiche de validation signale le renouvellement, avec l'alias et la dépense de la clé d'origine", async () => {
    const { origine, renouvelee, ancienne } = await renouvellement();
    [...litellm.keys.values()].find((k) => k.key === ancienne)!.spend = 3;
    expect((await getRequestReview(deps, admin, renouvelee)).renewal).toEqual({ alias: `mmaudet-r-d-compte-rendu-hebdo-${origine.slice(-4)}`, spend: 3 });
  });

  test("la fiche de validation donne aussi la dépense d'une clé d'origine expirée", async () => {
    const { origine, renouvelee, ancienne } = await renouvellement();
    [...litellm.keys.values()].find((k) => k.key === ancienne)!.spend = 3;
    maintenant = new Date(maintenant.getTime() + 61 * JOUR);
    expect((await getRequestReview(deps, admin, renouvelee)).renewal).toEqual({ alias: `mmaudet-r-d-compte-rendu-hebdo-${origine.slice(-4)}`, spend: 3 });
  });

  test("au retrait de la nouvelle clé, la clé d'origine encore émise est révoquée", async () => {
    const { origine, renouvelee, ancienne } = await renouvellement();
    await approveKeyRequest(deps, admin, renouvelee, { models: ["mistral-small"], budget: 15, budgetDuration: "30d", days: 60, rpmLimit: null, tpmLimit: null });
    const { key } = await pickUpKey(deps, titulaire, renouvelee);
    expect([...litellm.keys.values()].map((k) => k.key)).toEqual([key]);
    expect(Object.fromEntries((await listMyKeys(deps, titulaire)).keys.map((k) => [k.requestId, k.status]))).toEqual({ [origine]: "REVOQUEE", [renouvelee]: "CLE_EMISE" });
    expect(ancienne).not.toBe(key);
    expect((await listAudit(testDb)).map((e) => [e.action, e.targetId, e.details.raison])).toContainEqual(["KEY_REVOKED", origine, "renouvellement"]);
  });

  test("une clé d'origine déjà révoquée reste en l'état ; un renouvellement refusé laisse la clé d'origine intacte", async () => {
    const premier = await renouvellement();
    await revokeKey(deps, titulaire, premier.origine);
    await approveKeyRequest(deps, admin, premier.renouvelee, { models: ["mistral-small"], budget: 15, budgetDuration: "30d", days: 60, rpmLimit: null, tpmLimit: null });
    await pickUpKey(deps, titulaire, premier.renouvelee);

    const second = await renouvellement();
    await refuseRequest(deps, admin, second.renouvelee, "Budget à revoir");
    expect([...litellm.keys.values()].some((k) => k.key === second.ancienne)).toBe(true);
    expect((await listMyKeys(deps, titulaire)).keys.find((k) => k.requestId === second.origine)?.status).toBe("CLE_EMISE");
  });
});

describe("tâche quotidienne : échéances et rappels (ticket #25)", () => {
  let mailer: FakeMailer;
  const tache = () => runDailyTask({ ...deps, mailer, portalUrl: "https://portail.test" });
  const sujets = () => mailer.outbox.map((c) => [c.to[0], c.subject]);
  const approuveeLe = new Date("2026-10-01T09:00:00Z");

  beforeEach(() => {
    mailer = new FakeMailer();
  });

  test("le rappel de retrait part le matin du troisième jour avant l'échéance, une seule fois", async () => {
    // Approbation le 1er octobre à 14 h (heure de Paris) : échéance de retrait le 15 octobre à 14 h.
    maintenant = new Date("2026-10-01T12:00:00Z");
    await demandeApprouvee();
    maintenant = new Date("2026-10-11T05:00:00Z"); // 11 octobre, 7 h à Paris : J-4
    await tache();
    expect(mailer.outbox).toEqual([]);
    maintenant = new Date("2026-10-12T05:00:00Z"); // 12 octobre, 7 h à Paris : J-3
    expect(await tache()).toMatchObject({ rappelsRetrait: 1 });
    await tache();
    expect(sujets()).toEqual([["mmaudet@linagora.com", "[AI GATEWAY] Rappel : votre clé est à retirer / Reminder: your key is waiting to be picked up"]]);
    expect(mailer.outbox[0].text).toContain("Retirez-la avant le 15 octobre 2026 dans « Mes clés »");
  });

  test("une demande non retirée dans le délai expire, à la lecture (salarié comme admin) comme par la tâche, et ne se retire plus", async () => {
    const id = await demandeApprouvee();
    maintenant = new Date(approuveeLe.getTime() + 15 * JOUR);
    expect((await getRequestReview(deps, admin, id)).status).toBe("EXPIREE");
    expect((await listMyKeys(deps, titulaire)).toPickUp).toEqual([]);
    expect((await listMyRequests(deps, titulaire)).find((r) => r.id === id)?.status).toBe("EXPIREE");
    await expect(pickUpKey(deps, titulaire, id)).rejects.toMatchObject({ code: "transition_interdite" });
    expect((await listAudit(testDb)).map((e) => [e.actorUid, e.action, e.targetId])).toContainEqual(["systeme", "REQUEST_EXPIRED", id]);
  });

  test("une clé arrivée à expiration passe en « Expirée » par la tâche, qui en rend compte", async () => {
    const id = await demandeApprouvee();
    await pickUpKey(deps, titulaire, id);
    maintenant = new Date(approuveeLe.getTime() + 61 * JOUR);
    expect(await tache()).toMatchObject({ demandesExpirees: 0, clesExpirees: 1 });
    expect((await listMyKeys(deps, titulaire)).keys[0].status).toBe("EXPIREE");
    expect((await listAudit(testDb)).map((e) => [e.actorUid, e.action, e.targetId])).toContainEqual(["systeme", "KEY_EXPIRED", id]);
  });
});

describe("courriels des actions d'un admin sur une clé (ticket #26)", () => {
  let mailer: FakeMailer;
  const avecCourriel = () => ({ ...deps, mailer, portalUrl: "https://portail.test" });

  beforeEach(() => {
    mailer = new FakeMailer();
  });

  test("révocation, blocage et déblocage par un admin envoient chacun un courriel au titulaire", async () => {
    const bloquee = await demandeApprouvee();
    await pickUpKey(deps, titulaire, bloquee);
    const revoquee = await demandeApprouvee();
    await pickUpKey(deps, titulaire, revoquee);
    const alias = (id: string) => `mmaudet-r-d-compte-rendu-hebdo-${id.slice(-4)}`;

    await blockKey(avecCourriel(), admin, bloquee);
    await unblockKey(avecCourriel(), admin, bloquee);
    await revokeKey(avecCourriel(), admin, revoquee);
    expect(mailer.outbox.map((c) => [c.to, c.subject])).toEqual([
      [["mmaudet@linagora.com"], `[AI GATEWAY] Votre clé ${alias(bloquee)} est bloquée / Your key ${alias(bloquee)} is blocked`],
      [["mmaudet@linagora.com"], `[AI GATEWAY] Votre clé ${alias(bloquee)} est débloquée / Your key ${alias(bloquee)} is unblocked`],
      [["mmaudet@linagora.com"], `[AI GATEWAY] Votre clé ${alias(revoquee)} a été révoquée / Your key ${alias(revoquee)} has been revoked`],
    ]);
    expect(mailer.outbox[2].text).toContain("Un administrateur a révoqué votre clé d'API");
    expect(mailer.outbox[2].text).toContain("https://portail.test/cles");
  });

  test("un courriel qui ne part pas n'empêche pas l'action de l'admin", async () => {
    const id = await demandeApprouvee();
    await pickUpKey(deps, titulaire, id);
    mailer.panne = true;
    await blockKey(avecCourriel(), admin, id);
    expect((await listMyKeys(deps, titulaire)).keys[0].gatewayState?.blocked).toBe(true);
    expect(mailer.outbox).toEqual([]);
  });

  test("les actions du titulaire sur ses propres clés n'envoient aucun courriel", async () => {
    const id = await demandeApprouvee();
    await pickUpKey(avecCourriel(), titulaire, id);
    await replaceKey(avecCourriel(), titulaire, id);
    const brouillon = await renewalDraft(avecCourriel(), titulaire, id);
    const { id: renouvelee } = await createKeyRequest(deps, titulaire, { ...demande, ...brouillon, justification: "Renouvellement", commitment: true, renewsRequestId: id });
    await approveKeyRequest(deps, admin, renouvelee, { models: ["mistral-small"], budget: 15, budgetDuration: "30d", days: 60, rpmLimit: null, tpmLimit: null });
    await pickUpKey(avecCourriel(), titulaire, renouvelee);
    await revokeKey(avecCourriel(), titulaire, renouvelee);
    expect(mailer.outbox).toEqual([]);
  });
});

describe("actions d'une intégration sur les clés du collaborateur (ticket #81)", () => {
  let mailer: FakeMailer;
  const avecCourriel = () => ({ ...deps, mailer, portalUrl: "https://portail.test" });
  /** Le titulaire, agissant par l'intégration Team Manager. */
  const parIntegration = { ...titulaire, canal: "team-manager" };

  beforeEach(async () => {
    mailer = new FakeMailer();
    await testDb.integration.create({ data: { id: "team-manager", name: "Team Manager", scopes: ["LECTURE", "DEMANDES", "CLES"], ipRanges: ["10.0.0.0/8"], createdBy: "jdupont" } });
  });

  test("un retrait par une intégration envoie au titulaire un courriel qui la nomme et l'invite à prévenir les administrateurs", async () => {
    const id = await demandeApprouvee();
    const { alias } = await pickUpKey(avecCourriel(), parIntegration, id);
    expect(mailer.outbox.map((c) => [c.to, c.subject])).toEqual([
      [["mmaudet@linagora.com"], `[AI GATEWAY] Votre clé ${alias} a été retirée par Team Manager / Your key ${alias} was picked up by Team Manager`],
    ]);
    expect(mailer.outbox[0].text).toContain(`L'intégration Team Manager a retiré en votre nom votre clé d'API ${alias}`);
    expect(mailer.outbox[0].text).toContain("Si vous n'êtes pas à l'origine de ce retrait, prévenez aussitôt les administrateurs du portail.");
    expect(mailer.outbox[0].text).toContain("https://portail.test/cles");
  });

  test("le retrait par une intégration d'une clé de renouvellement annonce aussi la révocation de la clé renouvelée", async () => {
    const origine = await demandeApprouvee();
    const { alias: renouvelee } = await pickUpKey(deps, titulaire, origine);
    const brouillon = await renewalDraft(deps, titulaire, origine);
    const { id } = await createKeyRequest(deps, titulaire, { ...demande, ...brouillon, justification: "Renouvellement", commitment: true, renewsRequestId: origine });
    await approveKeyRequest(deps, admin, id, { models: ["mistral-small"], budget: 15, budgetDuration: "30d", days: 60, rpmLimit: null, tpmLimit: null });
    await pickUpKey(avecCourriel(), parIntegration, id);
    expect(mailer.outbox).toHaveLength(1);
    expect(mailer.outbox[0].text).toContain(`Elle renouvelle votre clé ${renouvelee}, que la passerelle refuse désormais.`);
  });

  test("un remplacement par une intégration annonce au titulaire l'ancienne clé et sa remplaçante", async () => {
    const id = await demandeApprouvee();
    const { alias: ancien } = await pickUpKey(deps, titulaire, id);
    const { alias: nouvel } = await replaceKey(avecCourriel(), parIntegration, id);
    expect(mailer.outbox.map((c) => c.subject)).toEqual([`[AI GATEWAY] Votre clé ${ancien} a été remplacée par Team Manager / Your key ${ancien} was replaced by Team Manager`]);
    expect(mailer.outbox[0].text).toContain(`L'intégration Team Manager a remplacé en votre nom votre clé d'API ${ancien} par une nouvelle clé, ${nouvel}`);
  });

  test("une révocation par une intégration coupe la clé et l'annonce au titulaire", async () => {
    const id = await demandeApprouvee();
    const { key, alias } = await pickUpKey(deps, titulaire, id);
    await revokeOwnKey(avecCourriel(), parIntegration, id);
    expect([...litellm.keys.values()].some((k) => k.key === key)).toBe(false);
    expect((await listMyKeys(deps, titulaire)).keys[0].status).toBe("REVOQUEE");
    expect(mailer.outbox.map((c) => c.subject)).toEqual([`[AI GATEWAY] Votre clé ${alias} a été révoquée par Team Manager / Your key ${alias} was revoked by Team Manager`]);
  });

  test("par une intégration, on ne révoque que sa propre clé, même responsable de son équipe", async () => {
    const id = await demandeApprouvee();
    await pickUpKey(deps, titulaire, id);
    await testDb.teamManager.create({ data: { teamId: "equipe-rd", uid: "pmartin", email: "pmartin@linagora.com", designatedBy: "jdupont" } });
    await expect(revokeOwnKey(deps, { ...collegue, canal: "team-manager" }, id)).rejects.toMatchObject({ code: "introuvable" });
    expect((await listMyKeys(deps, titulaire)).keys[0].status).toBe("CLE_EMISE");
  });

  test("le retrait, le remplacement et la révocation par une intégration sont inscrits au journal d'audit avec son canal", async () => {
    const id = await demandeApprouvee();
    await pickUpKey(deps, parIntegration, id);
    await replaceKey(deps, parIntegration, id);
    await revokeOwnKey(deps, parIntegration, id);
    const actions = (await listAudit(testDb)).filter((e) => e.targetId === id && e.action.startsWith("KEY_"));
    expect(actions.map((e) => [e.actorUid, e.action, e.details.canal])).toEqual([
      ["mmaudet", "KEY_GENERATED", "team-manager"],
      ["mmaudet", "KEY_REPLACED", "team-manager"],
      ["mmaudet", "KEY_REVOKED", "team-manager"],
    ]);
  });
});

describe("robustesse du retrait (revue de code)", () => {
  test("deux retraits simultanés de la même demande : un seul aboutit, sans clé orpheline", async () => {
    const id = await demandeApprouvee();
    const resultats = await Promise.allSettled([pickUpKey(deps, titulaire, id), pickUpKey(deps, titulaire, id)]);
    expect(resultats.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(resultats.find((r) => r.status === "rejected")).toMatchObject({ reason: { code: "transition_interdite" } });
    expect(litellm.keys.size).toBe(1);
  });

  test("au-delà de cinq retraits ou remplacements en dix minutes, le titulaire doit patienter, et l'erreur dit combien de temps", async () => {
    const limites = { ...deps, limiteGenerations: new LimiteDeDebit(5, 10 * 60_000) };
    const id = await demandeApprouvee();
    await pickUpKey(limites, titulaire, id);
    for (let i = 0; i < 4; i++) await replaceKey(limites, titulaire, id);
    await expect(replaceKey(limites, titulaire, id)).rejects.toMatchObject({ code: "trop_de_generations", attente: 10 * 60_000 });
    maintenant = new Date(maintenant.getTime() + 10 * 60_000 + 1);
    await expect(replaceKey(limites, titulaire, id)).resolves.toMatchObject({ key: expect.stringMatching(/^sk-/) });
  });
});

describe("clé sans expiration (décision du 2026-09-25)", () => {
  /** Demande approuvée pour une clé qui n'expire jamais. */
  async function demandeSansExpiration(): Promise<string> {
    const { id } = await createKeyRequest(deps, titulaire, { ...demande, requestedDays: SANS_EXPIRATION });
    await approveKeyRequest(deps, admin, id, { models: ["mistral-small"], budget: 15, budgetDuration: "30d", days: SANS_EXPIRATION, rpmLimit: null, tpmLimit: null });
    return id;
  }

  test("la clé est générée sans durée et ne passe jamais en « Expirée »", async () => {
    const id = await demandeSansExpiration();
    const { key } = await pickUpKey(deps, titulaire, id);
    expect([...litellm.keys.values()].find((k) => k.key === key)).toMatchObject({ duration: null, expiresAt: null });
    maintenant = new Date(maintenant.getTime() + 10 * 365 * JOUR);
    expect((await listMyKeys(deps, titulaire)).keys).toEqual([expect.objectContaining({ requestId: id, status: "CLE_EMISE", expiresAt: null })]);
  });

  test("elle se remplace, et sa remplaçante n'expire pas non plus", async () => {
    const id = await demandeSansExpiration();
    await pickUpKey(deps, titulaire, id);
    const { key } = await replaceKey(deps, titulaire, id);
    expect([...litellm.keys.values()].find((k) => k.key === key)).toMatchObject({ duration: null, expiresAt: null });
  });

  test("elle ne reçoit aucun rappel d'expiration", async () => {
    const mailer = new FakeMailer();
    const id = await demandeSansExpiration();
    await pickUpKey(deps, titulaire, id);
    for (const jours of [1, 30, 365]) {
      maintenant = new Date(maintenant.getTime() + jours * JOUR);
      await runDailyTask({ ...deps, mailer });
    }
    expect(mailer.outbox).toEqual([]);
  });
});

describe("rappels d'expiration un mois, sept jours et la veille, selon la durée de la clé (ticket #27)", () => {
  let mailer: FakeMailer;
  const tache = () => runDailyTask({ ...deps, mailer, portalUrl: "https://portail.test" });
  /** Délai annoncé par chaque rappel envoyé, dans l'ordre (« dans un mois », « dans 7 jours », « demain »…). */
  const delais = () => mailer.outbox.map((c) => /expire (aujourd'hui|demain|dans un mois|dans \d+ jours)/.exec(c.text)?.[1]);

  /** Clé d'une durée de `jours` jours, retirée le 1er octobre 2026 à 14 h (heure de Paris). */
  async function cleDe(jours: number): Promise<string> {
    const { id } = await createKeyRequest(deps, titulaire, { ...demande, requestedDays: jours });
    await approveKeyRequest(deps, admin, id, { models: ["mistral-small"], budget: 15, budgetDuration: "30d", days: jours, rpmLimit: null, tpmLimit: null });
    maintenant = new Date("2026-10-01T12:00:00Z");
    await pickUpKey(deps, titulaire, id);
    return id;
  }

  /** La tâche passe chaque jour du `debut` au `fin` (inclus), à 5 h et 6 h UTC comme le cron du serveur. */
  async function chaqueMatin(debut: string, fin: string): Promise<void> {
    for (let jour = Date.parse(debut); jour <= Date.parse(fin); jour += JOUR) {
      for (const heure of [5, 6]) {
        maintenant = new Date(jour + heure * 3_600_000);
        await tache();
      }
    }
  }

  beforeEach(() => {
    mailer = new FakeMailer();
  });

  test.each([
    [1, []],
    [7, ["demain"]],
    [30, ["dans 7 jours", "demain"]],
    [90, ["dans un mois", "dans 7 jours", "demain"]],
  ])("une clé de %i jour(s) reçoit les rappels %j, chacun une seule fois", async (jours, attendus) => {
    await cleDe(jours);
    await chaqueMatin("2026-10-02", "2027-01-05");
    expect(delais()).toEqual(attendus);
  });

  test("chaque rappel part le matin du jour annoncé, avec la date d'expiration et le lien vers « Mes clés »", async () => {
    const id = await cleDe(90);
    // Expiration le 30 décembre à 13 h (heure de Paris) : rappels les 30 novembre, 23 et 29 décembre, à 7 h.
    await chaqueMatin("2026-10-02", "2026-11-29");
    expect(mailer.outbox).toEqual([]);
    await chaqueMatin("2026-11-30", "2026-11-30");
    expect(delais()).toEqual(["dans un mois"]);
    expect(mailer.outbox[0].subject).toBe(`[AI GATEWAY] Rappel : votre clé mmaudet-r-d-compte-rendu-hebdo-${id.slice(-4)} expire bientôt / Reminder: your key mmaudet-r-d-compte-rendu-hebdo-${id.slice(-4)} expires soon`);
    expect(mailer.outbox[0].text).toContain("expire dans un mois, le 30 décembre 2026");
    expect(mailer.outbox[0].text).toContain("expires in a month, on December 30, 2026");
    expect(mailer.outbox[0].text).toContain(`Bonjour Michel-Marie Maudet,\n\nVotre clé d'API mmaudet-r-d-compte-rendu-hebdo-${id.slice(-4)} expire dans un mois`);
    expect(mailer.outbox[0].text).toContain("- Équipe : R&D\n- Niveau de confidentialité : N2 Interne\n- Modèles : mistral-small");
    expect(mailer.outbox[0].text).toContain("https://portail.test/cles");
    await chaqueMatin("2026-12-01", "2026-12-22");
    expect(delais()).toEqual(["dans un mois"]);
    await chaqueMatin("2026-12-23", "2026-12-23");
    expect(delais()).toEqual(["dans un mois", "dans 7 jours"]);
  });

  test("après plusieurs jours sans tâche, seul le rappel le plus proche de l'échéance part", async () => {
    await cleDe(90);
    // Première tâche le 25 décembre, cinq jours avant l'expiration : les rappels à un mois et à sept jours sont passés.
    await chaqueMatin("2026-12-25", "2027-01-05");
    expect(delais()).toEqual(["dans 5 jours", "demain"]);
  });

  test("une clé remplacée garde ses rappels ; une clé révoquée n'en reçoit plus", async () => {
    const remplacee = await cleDe(90);
    await chaqueMatin("2026-10-02", "2026-11-30");
    await replaceKey(deps, titulaire, remplacee);
    await chaqueMatin("2026-12-01", "2026-12-23");
    expect(delais()).toEqual(["dans un mois", "dans 7 jours"]);
    await revokeKey(deps, titulaire, remplacee);
    await chaqueMatin("2026-12-24", "2027-01-05");
    expect(delais()).toEqual(["dans un mois", "dans 7 jours"]);
  });
});
