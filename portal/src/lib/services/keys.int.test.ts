import { beforeEach, describe, expect, test } from "vitest";
import { resetDb, testDb } from "@/test/db";
import { FakeLiteLLM } from "@/test/fake-litellm";
import { FakeMailer } from "@/test/fake-mailer";
import { approveKeyRequest, getRequestReview, refuseRequest } from "./admin-requests";
import { listAudit } from "./audit";
import { saveCatalogEntry } from "./catalog";
import { blockKey, listAllKeys, listMyKeys, pickUpKey, renewalDraft, replaceKey, revokeKey, runDailyTask, unblockKey } from "./keys";
import { createKeyRequest, type KeyRequestInput, listMyRequests } from "./requests";
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

describe("révocation par le titulaire (ticket #17)", () => {
  test("le titulaire révoque sa clé : elle est supprimée de la passerelle et la demande passe en « Révoquée »", async () => {
    const id = await demandeApprouvee();
    const { key } = await pickUpKey(deps, titulaire, id);
    await revokeKey(deps, titulaire, id);
    expect([...litellm.keys.values()].some((k) => k.key === key)).toBe(false);
    expect((await listMyKeys(deps, titulaire)).keys).toEqual([expect.objectContaining({ requestId: id, status: "REVOQUEE", usage: null })]);
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

    const cles = await listAllKeys(deps, admin);
    expect(cles).toHaveLength(2);
    expect(cles.find((k) => k.requestId === id)).toMatchObject({
      holderUid: "mmaudet",
      holderEmail: "mmaudet@linagora.com",
      teamAlias: "R&D",
      dataLevel: "N2",
      alias: `mmaudet-r-d-compte-rendu-hebdo-${id.slice(-4)}`,
      status: "CLE_EMISE",
      expiresAt: new Date(maintenant.getTime() + 60 * JOUR),
      usage: { spend: 1.25, maxBudget: 15, blocked: false },
    });
    expect(cles.find((k) => k.requestId === idCollegue)).toMatchObject({ holderUid: "pmartin", usage: { spend: 0, maxBudget: 10 } });
  });

  test("un salarié n'accède pas à la liste des clés", async () => {
    await expect(listAllKeys(deps, titulaire)).rejects.toMatchObject({ code: "interdit" });
  });

  test("un admin révoque la clé d'un salarié, avec le même effet ; le journal d'audit le nomme comme auteur", async () => {
    const id = await demandeApprouvee();
    const { key } = await pickUpKey(deps, titulaire, id);
    await revokeKey(deps, admin, id);
    expect([...litellm.keys.values()].some((k) => k.key === key)).toBe(false);
    expect((await listAllKeys(deps, admin))[0]).toMatchObject({ requestId: id, status: "REVOQUEE" });
    expect((await listAudit(testDb)).map((e) => [e.actorUid, e.action, e.targetId])).toContainEqual(["jdupont", "KEY_REVOKED", id]);
  });
});

describe("blocage et déblocage d'une clé (ticket #20)", () => {
  test("un admin bloque puis débloque une clé ; la demande reste « Clé émise » et l'état bloqué se voit dans « Mes clés »", async () => {
    const id = await demandeApprouvee();
    const { key } = await pickUpKey(deps, titulaire, id);
    await blockKey(deps, admin, id);
    expect([...litellm.keys.values()].find((k) => k.key === key)?.blocked).toBe(true);
    expect((await listMyKeys(deps, titulaire)).keys[0]).toMatchObject({ status: "CLE_EMISE", usage: { blocked: true } });
    await unblockKey(deps, admin, id);
    expect((await listMyKeys(deps, titulaire)).keys[0]).toMatchObject({ status: "CLE_EMISE", usage: { blocked: false } });
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
      keyType: "PERSONNELLE",
      alias: `mmaudet-r-d-compte-rendu-hebdo-${origine.slice(-4)}`,
    });
    const { renouvelee } = await renouvellement();
    expect((await listAudit(testDb)).map((e) => [e.action, e.targetId, e.details])).toContainEqual(["RENEWAL_REQUESTED", renouvelee, expect.objectContaining({ origine: expect.any(String) })]);
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

  test("le rappel de retrait part trois jours avant l'échéance, une seule fois", async () => {
    await demandeApprouvee();
    maintenant = new Date(approuveeLe.getTime() + 10 * JOUR);
    await tache();
    expect(mailer.outbox).toEqual([]);
    maintenant = new Date(approuveeLe.getTime() + 11 * JOUR + 3_600_000);
    expect(await tache()).toMatchObject({ rappelsRetrait: 1 });
    await tache();
    expect(sujets()).toEqual([["mmaudet@linagora.com", "Rappel : votre clé est à retirer / Reminder: your key is waiting to be picked up"]]);
    expect(mailer.outbox[0].text).toContain("Retirez-la avant le 15 octobre 2026 dans « Mes clés »");
  });

  test("le rappel d'expiration part sept jours avant l'expiration de la clé, une seule fois", async () => {
    const id = await demandeApprouvee();
    await pickUpKey(deps, titulaire, id);
    maintenant = new Date(approuveeLe.getTime() + 53 * JOUR + 3_600_000);
    expect(await tache()).toMatchObject({ rappelsExpiration: 1 });
    await tache();
    expect(sujets()).toEqual([
      ["mmaudet@linagora.com", `Rappel : votre clé mmaudet-r-d-compte-rendu-hebdo-${id.slice(-4)} expire bientôt / Reminder: your key mmaudet-r-d-compte-rendu-hebdo-${id.slice(-4)} expires soon`],
    ]);
    expect(mailer.outbox[0].text).toContain("https://portail.test/cles");
  });

  test("une demande non retirée dans le délai expire, à la lecture comme par la tâche, et ne se retire plus", async () => {
    const id = await demandeApprouvee();
    maintenant = new Date(approuveeLe.getTime() + 15 * JOUR);
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
