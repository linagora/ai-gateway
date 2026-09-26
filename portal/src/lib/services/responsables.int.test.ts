import { beforeEach, describe, expect, test } from "vitest";
import { resetDb, testDb } from "@/test/db";
import { FakeLiteLLM } from "@/test/fake-litellm";
import { FakeMailer } from "@/test/fake-mailer";
import { approveKeyRequest, approveTeamJoinRequest, countAdminPending, getRequestReview, listPendingRequests, listProcessedRequests, refuseRequest, requestCompletion } from "./admin-requests";
import { listAudit } from "./audit";
import { saveCatalogEntry } from "./catalog";
import { blockKey, listActiveKeys, listKeysToPickUp, pickUpKey, revokeKey, unblockKey } from "./keys";
import { createKeyRequest, createTeamJoinRequest } from "./requests";
import { addTeamMember, deleteTeam, designateManager, getTeamPage, listTeamOverviews, removeTeamMember, renameTeam } from "./teams";

/*
 * Droits du responsable d'équipe (spécification #35, tickets #40 à #42). Deux équipes : R&D, dont Léa Bernard est
 * responsable, et Data, sans responsable. Paul Martin est membre de R&D, Jeanne Dupont est admin.
 */
const admin = { uid: "jdupont", email: "jdupont@linagora.com", name: "Jeanne Dupont", isAdmin: true };
const responsable = { uid: "lbernard", email: "lbernard@linagora.com", name: "Léa Bernard", isAdmin: false };
const membre = { uid: "pmartin", email: "pmartin@linagora.com", name: "Paul Martin", isAdmin: false };
const ADMINS = ["admins@linagora.com"];

let litellm: FakeLiteLLM;
let mailer: FakeMailer;
let deps: { db: typeof testDb; litellm: FakeLiteLLM; mailer: FakeMailer; adminEmails: string[]; portalUrl: string };

beforeEach(async () => {
  await resetDb();
  litellm = new FakeLiteLLM()
    .withModel({ modelName: "mistral-small" })
    .withTeam({ teamId: "equipe-rd", teamAlias: "R&D", models: [], memberUids: ["lbernard", "pmartin"] })
    .withTeam({ teamId: "equipe-data", teamAlias: "Data", models: [], memberUids: ["jdupont"] });
  for (const p of [admin, responsable, membre]) litellm.users.set(p.uid, { email: p.email });
  mailer = new FakeMailer();
  deps = { db: testDb, litellm, mailer, adminEmails: ADMINS, portalUrl: "https://portail.test" };
  await saveCatalogEntry(deps, admin, { modelName: "mistral-small", displayNameFr: "Mistral Small", shortDescriptionFr: "…", longDescriptionFr: "…", useCases: [], recommendedFor: [], dataLevel: "N2", visible: true });
  await testDb.teamManager.create({ data: { teamId: "equipe-rd", uid: "lbernard", email: "lbernard@linagora.com", designatedBy: "jdupont" } });
});

/** Demande enregistrée directement, dans une équipe et un statut donnés. */
const demande = (uid: string, teamId: string, teamAlias: string, status: "SOUMISE" | "APPROUVEE" | "REFUSEE" | "CLE_EMISE" = "SOUMISE") =>
  testDb.accessRequest.create({
    data: {
      kind: "CLE", status, requesterUid: uid, requesterEmail: `${uid}@linagora.com`, teamId, teamAlias, dataLevel: "N2", models: ["mistral-small"],
      justification: "Essai", ...(status === "CLE_EMISE" ? { keyAlias: `${uid}-${teamId}`, keyTokenId: `empreinte-${uid}-${teamId}`, keyIssuedAt: new Date() } : {}),
    },
  });

describe("gestion limitée du responsable d'équipe (ticket #40)", () => {
  test("un responsable ne voit, dans la file, l'archive, les clés et les équipes, que ce qui concerne ses équipes ; un admin voit tout", async () => {
    await demande("pmartin", "equipe-rd", "R&D");
    await demande("jdupont", "equipe-data", "Data");
    await demande("pmartin", "equipe-rd", "R&D", "REFUSEE");
    await demande("jdupont", "equipe-data", "Data", "REFUSEE");
    await demande("pmartin", "equipe-rd", "R&D", "APPROUVEE");
    await demande("jdupont", "equipe-data", "Data", "APPROUVEE");
    const equipes = <T extends { teamAlias: string }>(lignes: T[]) => [...new Set(lignes.map((l) => l.teamAlias))];
    expect(equipes(await listPendingRequests(deps, responsable))).toEqual(["R&D"]);
    expect(equipes((await listProcessedRequests(deps, responsable)).elements)).toEqual(["R&D"]);
    expect(equipes(await listKeysToPickUp(deps, responsable))).toEqual(["R&D"]);
    expect((await listTeamOverviews(deps, responsable)).map((t) => t.teamAlias)).toEqual(["R&D"]);
    expect(equipes(await listPendingRequests(deps, admin)).sort()).toEqual(["Data", "R&D"]);
    expect((await listTeamOverviews(deps, admin)).map((t) => t.teamAlias)).toEqual(["Data", "R&D"]);
  });

  test("les clés actives d'une autre équipe ne sont pas montrées au responsable", async () => {
    await demande("pmartin", "equipe-rd", "R&D", "CLE_EMISE");
    await demande("jdupont", "equipe-data", "Data", "CLE_EMISE");
    expect((await listActiveKeys(deps, responsable)).map((k) => k.teamAlias)).toEqual(["R&D"]);
    expect((await listActiveKeys(deps, admin)).map((k) => k.teamAlias).sort()).toEqual(["Data", "R&D"]);
    // Filtrées sur une équipe hors de son autorité, les clés restent invisibles au responsable.
    expect(await listActiveKeys(deps, responsable, "equipe-data")).toEqual([]);
  });

  test("la pastille d'un responsable compte les demandes à valider de ses équipes, hors les siennes", async () => {
    await demande("pmartin", "equipe-rd", "R&D");
    await demande("lbernard", "equipe-rd", "R&D");
    await demande("jdupont", "equipe-data", "Data");
    await demande("pmartin", "equipe-rd", "R&D", "APPROUVEE");
    expect(await countAdminPending(deps, responsable)).toEqual({ demandes: 1, clesARetirer: 1, abonnementsADeclarer: 0 });
    expect(await countAdminPending(deps, admin)).toEqual({ demandes: 3, clesARetirer: 1, abonnementsADeclarer: 0 });
  });

  test("une demande ou une équipe hors de son autorité est introuvable pour un responsable ; un salarié sans rôle n'accède pas à la gestion", async () => {
    const autre = await demande("jdupont", "equipe-data", "Data");
    const sienne = await demande("pmartin", "equipe-rd", "R&D");
    expect((await getRequestReview(deps, responsable, sienne.id)).teamAlias).toBe("R&D");
    await expect(getRequestReview(deps, responsable, autre.id)).rejects.toMatchObject({ code: "introuvable" });
    await expect(getTeamPage(deps, responsable, "equipe-data")).rejects.toMatchObject({ code: "introuvable" });
    expect((await getTeamPage(deps, responsable, "equipe-rd")).members).toEqual(["lbernard", "pmartin"]);
    await expect(listPendingRequests(deps, membre)).rejects.toMatchObject({ code: "interdit" });
    await expect(listTeamOverviews(deps, membre)).rejects.toMatchObject({ code: "interdit" });
  });

  test("une nouvelle demande est annoncée aux responsables de l'équipe et aux admins ; celle d'un responsable, aux autres responsables et aux admins", async () => {
    await createTeamJoinRequest(deps, admin, { teamId: "equipe-rd", justification: "Rejoindre R&D" });
    expect(mailer.outbox.map((m) => m.to)).toEqual([[...ADMINS, "lbernard@linagora.com"]]);
    mailer.outbox.length = 0;
    await createKeyRequest(deps, responsable, { teamId: "equipe-rd", dataLevel: "N2", models: ["mistral-small"], justification: "Essai", project: null, requestedBudget: null, requestedDays: 90, commitment: true });
    expect(mailer.outbox.map((m) => m.to)).toEqual([ADMINS]);
  });
});

describe("le responsable valide les demandes de ses équipes (ticket #41)", () => {
  const parametres = { models: ["mistral-small"], budget: 10, budgetDuration: "30d", days: 90, rpmLimit: null, tpmLimit: null };

  test("un responsable approuve une demande de clé de son équipe, avec les contrôles de politique ; la décision est à son nom, envoyée au demandeur et annoncée aux admins et aux autres responsables", async () => {
    await testDb.teamManager.create({ data: { teamId: "equipe-rd", uid: "cdurand", email: "cdurand@linagora.com", designatedBy: "jdupont" } });
    const { id } = await createKeyRequest(deps, membre, { teamId: "equipe-rd", dataLevel: "N2", models: ["mistral-small"], justification: "Essai", project: null, requestedBudget: null, requestedDays: 90, commitment: true });
    mailer.outbox.length = 0;
    // Les contrôles de politique restent bloquants : un modèle inconnu est refusé.
    await expect(approveKeyRequest(deps, responsable, id, { ...parametres, models: ["modele-inconnu"] })).rejects.toMatchObject({ code: "controles_en_echec" });
    await approveKeyRequest(deps, responsable, id, parametres);
    const approuvee = await testDb.accessRequest.findUniqueOrThrow({ where: { id } });
    expect(approuvee).toMatchObject({ status: "APPROUVEE", decidedBy: "lbernard" });
    expect((await listAudit(testDb)).at(-1)).toMatchObject({ actorUid: "lbernard", action: "REQUEST_APPROVED", targetId: id });
    expect(mailer.outbox.map((m) => [m.to, m.subject])).toEqual([
      [["pmartin@linagora.com"], "[AI GATEWAY] Votre demande de clé est approuvée / Your key request is approved"],
      [[...ADMINS, "cdurand@linagora.com"], "[AI GATEWAY] Demande traitée dans l'équipe R&D : pmartin / Request processed in the team R&D: pmartin"],
    ]);
    expect(mailer.outbox[1].text).toContain("Léa Bernard (lbernard) a approuvé la demande de clé d'API de pmartin.");
    expect(mailer.outbox[1].text).toContain(`https://portail.test/gestion/demandes/${id}`);
  });

  test("il valide aussi une demande N3 de son équipe, les contrôles de niveau restant bloquants, et une demande de renouvellement", async () => {
    litellm.withModel({ modelName: "qwen3.8" });
    await saveCatalogEntry(deps, admin, { modelName: "qwen3.8", displayNameFr: "Qwen 3.8", shortDescriptionFr: "…", longDescriptionFr: "…", useCases: [], recommendedFor: [], dataLevel: "N3", visible: true });
    const brouillon = { teamId: "equipe-rd", justification: "Essai", project: null, requestedBudget: null, requestedDays: 90, commitment: true };
    const { id: n3 } = await createKeyRequest(deps, membre, { ...brouillon, dataLevel: "N3", models: ["qwen3.8"] });
    await expect(approveKeyRequest(deps, responsable, n3, { ...parametres, models: ["qwen3.8", "mistral-small"] })).rejects.toMatchObject({
      code: "controles_en_echec",
      failedChecks: [{ id: "niveau_modeles", ok: false, offending: ["mistral-small"] }],
    });
    await approveKeyRequest(deps, responsable, n3, { ...parametres, models: ["qwen3.8"] });
    await pickUpKey(deps, membre, n3);
    const { id: renouvellement } = await createKeyRequest(deps, membre, { ...brouillon, dataLevel: "N3", models: ["qwen3.8"], renewsRequestId: n3 });
    await approveKeyRequest(deps, responsable, renouvellement, { ...parametres, models: ["qwen3.8"] });
    expect(await testDb.accessRequest.findMany({ where: { id: { in: [n3, renouvellement] } }, orderBy: { createdAt: "asc" }, select: { status: true, decidedBy: true, renewsRequestId: true } })).toEqual([
      { status: "CLE_EMISE", decidedBy: "lbernard", renewsRequestId: null },
      { status: "APPROUVEE", decidedBy: "lbernard", renewsRequestId: n3 },
    ]);
  });

  test("il refuse ou renvoie pour complément une demande de son équipe, et accepte une demande d'accès à son équipe", async () => {
    const refusee = await demande("pmartin", "equipe-rd", "R&D");
    await refuseRequest(deps, responsable, refusee.id, "Hors du périmètre de l'équipe");
    const aCompleter = await demande("pmartin", "equipe-rd", "R&D");
    await requestCompletion(deps, responsable, aCompleter.id, "Précisez le projet");
    const { id: acces } = await createTeamJoinRequest(deps, admin, { teamId: "equipe-rd", justification: "Rejoindre R&D" });
    await approveTeamJoinRequest(deps, responsable, acces);
    expect(await testDb.accessRequest.findMany({ where: { id: { in: [refusee.id, aCompleter.id, acces] } }, orderBy: { createdAt: "asc" }, select: { status: true, decidedBy: true } })).toEqual([
      { status: "REFUSEE", decidedBy: "lbernard" },
      { status: "A_COMPLETER", decidedBy: "lbernard" },
      { status: "APPROUVEE", decidedBy: "lbernard" },
    ]);
    expect((await litellm.getTeam("equipe-rd"))?.memberUids).toContain("jdupont");
  });

  test("la décision d'un admin dans une équipe qui a des responsables leur est annoncée, sans l'être aux admins", async () => {
    const { id: acces } = await createTeamJoinRequest(deps, membre, { teamId: "equipe-data", justification: "Rejoindre Data" });
    const { id: accesRd } = await createTeamJoinRequest(deps, admin, { teamId: "equipe-rd", justification: "Rejoindre R&D" });
    const refusee = await demande("pmartin", "equipe-rd", "R&D");
    const sienne = await demande("lbernard", "equipe-rd", "R&D");
    mailer.outbox.length = 0;
    // Data n'a pas de responsable : rien à annoncer.
    await approveTeamJoinRequest(deps, admin, acces);
    await approveTeamJoinRequest(deps, admin, accesRd);
    await refuseRequest(deps, admin, refusee.id, "Hors du périmètre");
    // Le responsable demandeur reçoit la décision sur sa demande, sans l'annonce faite aux responsables.
    await refuseRequest(deps, admin, sienne.id, "Hors du périmètre");
    expect(mailer.outbox.filter((m) => m.subject.includes("Demande traitée")).map((m) => [m.to, m.subject])).toEqual([
      [["lbernard@linagora.com"], "[AI GATEWAY] Demande traitée dans l'équipe R&D : jdupont / Request processed in the team R&D: jdupont"],
      [["lbernard@linagora.com"], "[AI GATEWAY] Demande traitée dans l'équipe R&D : pmartin / Request processed in the team R&D: pmartin"],
    ]);
    expect(mailer.outbox.find((m) => m.subject.includes("jdupont"))?.text).toContain("Jeanne Dupont (jdupont) a accepté la demande d'accès de jdupont.");
  });

  test("il ne peut pas décider de ses propres demandes ; un autre responsable de l'équipe ou un admin le peut", async () => {
    const sienne = await demande("lbernard", "equipe-rd", "R&D");
    await expect(approveKeyRequest(deps, responsable, sienne.id, parametres)).rejects.toMatchObject({ code: "quatre_yeux" });
    await expect(refuseRequest(deps, responsable, sienne.id, "Non")).rejects.toMatchObject({ code: "quatre_yeux" });
    await expect(requestCompletion(deps, responsable, sienne.id, "Précisez")).rejects.toMatchObject({ code: "quatre_yeux" });
    await testDb.teamManager.create({ data: { teamId: "equipe-rd", uid: "pmartin", email: "pmartin@linagora.com", designatedBy: "jdupont" } });
    await refuseRequest(deps, membre, sienne.id, "Hors du périmètre");
    expect((await testDb.accessRequest.findUniqueOrThrow({ where: { id: sienne.id } })).decidedBy).toBe("pmartin");
  });

  test("il ne décide pas d'une demande d'une autre équipe, et ne déplace une demande que vers une équipe qu'il gère", async () => {
    const autre = await demande("jdupont", "equipe-data", "Data");
    await expect(refuseRequest(deps, responsable, autre.id, "Non")).rejects.toMatchObject({ code: "introuvable" });
    await expect(approveKeyRequest(deps, responsable, autre.id, parametres)).rejects.toMatchObject({ code: "introuvable" });
    const sienne = await demande("pmartin", "equipe-rd", "R&D");
    await expect(approveKeyRequest(deps, responsable, sienne.id, { ...parametres, teamId: "equipe-data" })).rejects.toMatchObject({ code: "introuvable" });
    expect((await testDb.accessRequest.findUniqueOrThrow({ where: { id: sienne.id } })).status).toBe("SOUMISE");
  });
});

/** Clé réellement émise dans la passerelle simulée, et sa demande dans le portail. */
async function cleEmise(uid: string, teamId: string, teamAlias: string) {
  const alias = `${uid}-${teamId}-cle`;
  const { tokenId } = await litellm.generateKey({ userId: uid, teamId, models: ["mistral-small"], maxBudget: 5, budgetDuration: "30d", duration: "30d", rpmLimit: null, tpmLimit: null, alias, metadata: {} });
  return testDb.accessRequest.create({
    data: {
      kind: "CLE", status: "CLE_EMISE", requesterUid: uid, requesterEmail: `${uid}@linagora.com`, requesterName: uid, teamId, teamAlias, dataLevel: "N2",
      models: ["mistral-small"], approvedModels: ["mistral-small"], justification: "Essai", keyAlias: alias, keyTokenId: tokenId, keyIssuedAt: new Date(),
    },
  });
}

describe("le responsable gère les clés et les membres de ses équipes (ticket #42)", () => {
  test("il bloque, débloque et révoque une clé de son équipe ; le titulaire est prévenu, les admins et les autres responsables aussi", async () => {
    await testDb.teamManager.create({ data: { teamId: "equipe-rd", uid: "cdurand", email: "cdurand@linagora.com", designatedBy: "jdupont" } });
    const cle = await cleEmise("pmartin", "equipe-rd", "R&D");
    await blockKey(deps, responsable, cle.id);
    expect(litellm.keys.get(cle.keyTokenId!)?.blocked).toBe(true);
    await unblockKey(deps, responsable, cle.id);
    expect(litellm.keys.get(cle.keyTokenId!)?.blocked).toBe(false);
    mailer.outbox.length = 0;
    await revokeKey(deps, responsable, cle.id);
    expect((await testDb.accessRequest.findUniqueOrThrow({ where: { id: cle.id } })).status).toBe("REVOQUEE");
    expect(mailer.outbox.map((m) => [m.to, m.subject])).toEqual([
      [["pmartin@linagora.com"], "[AI GATEWAY] Votre clé pmartin-equipe-rd-cle a été révoquée / Your key pmartin-equipe-rd-cle has been revoked"],
      [[...ADMINS, "cdurand@linagora.com"], "[AI GATEWAY] Action sur une clé de l'équipe R&D : pmartin-equipe-rd-cle / Action on a key of the team R&D: pmartin-equipe-rd-cle"],
    ]);
    expect(mailer.outbox[0].text).toContain("Un responsable de votre équipe a révoqué votre clé d'API pmartin-equipe-rd-cle");
    expect(mailer.outbox[1].text).toContain("Léa Bernard (lbernard) a révoqué la clé pmartin-equipe-rd-cle de pmartin.");
    expect((await listAudit(testDb)).map((e) => [e.actorUid, e.action])).toEqual(expect.arrayContaining([["lbernard", "KEY_BLOCKED"], ["lbernard", "KEY_UNBLOCKED"], ["lbernard", "KEY_REVOKED"]]));
  });

  test("il ne bloque ni ne débloque sa propre clé : il ne lève pas un blocage décidé par un admin ; un autre responsable le peut", async () => {
    const sienne = await cleEmise("lbernard", "equipe-rd", "R&D");
    await blockKey(deps, admin, sienne.id);
    await expect(unblockKey(deps, responsable, sienne.id)).rejects.toMatchObject({ code: "quatre_yeux", params: { cas: "cle" } });
    await expect(blockKey(deps, responsable, sienne.id)).rejects.toMatchObject({ code: "quatre_yeux", params: { cas: "cle" } });
    expect(litellm.keys.get(sienne.keyTokenId!)?.blocked).toBe(true);
    await testDb.teamManager.create({ data: { teamId: "equipe-rd", uid: "pmartin", email: "pmartin@linagora.com", designatedBy: "jdupont" } });
    await unblockKey(deps, membre, sienne.id);
    expect(litellm.keys.get(sienne.keyTokenId!)?.blocked).toBe(false);
  });

  test("l'action d'un admin sur une clé d'une équipe qui a des responsables leur est annoncée, sans l'être aux admins", async () => {
    const cle = await cleEmise("pmartin", "equipe-rd", "R&D");
    await blockKey(deps, admin, cle.id);
    expect(mailer.outbox.map((m) => [m.to, m.subject])).toEqual([
      [["pmartin@linagora.com"], "[AI GATEWAY] Votre clé pmartin-equipe-rd-cle est bloquée / Your key pmartin-equipe-rd-cle is blocked"],
      [["lbernard@linagora.com"], "[AI GATEWAY] Action sur une clé de l'équipe R&D : pmartin-equipe-rd-cle / Action on a key of the team R&D: pmartin-equipe-rd-cle"],
    ]);
    expect(mailer.outbox[1].text).toContain("Jeanne Dupont (jdupont) a bloqué la clé pmartin-equipe-rd-cle de pmartin.");
  });

  test("une clé d'une autre équipe lui reste introuvable", async () => {
    const cle = await cleEmise("jdupont", "equipe-data", "Data");
    await expect(blockKey(deps, responsable, cle.id)).rejects.toMatchObject({ code: "introuvable" });
    await expect(revokeKey(deps, responsable, cle.id)).rejects.toMatchObject({ code: "introuvable" });
    expect((await testDb.accessRequest.findUniqueOrThrow({ where: { id: cle.id } })).status).toBe("CLE_EMISE");
  });

  test("il ne fait sortir de l'équipe ni un autre responsable ni lui-même : le rôle de responsable ne se retire que par un admin", async () => {
    await testDb.teamManager.create({ data: { teamId: "equipe-rd", uid: "pmartin", email: "pmartin@linagora.com", designatedBy: "jdupont" } });
    await expect(removeTeamMember(deps, responsable, { teamId: "equipe-rd", uid: "pmartin" })).rejects.toMatchObject({ code: "interdit" });
    await expect(removeTeamMember(deps, responsable, { teamId: "equipe-rd", uid: "lbernard" })).rejects.toMatchObject({ code: "interdit" });
    const equipe = await getTeamPage(deps, admin, "equipe-rd");
    expect([equipe.members, equipe.managers.map((m) => m.uid)]).toEqual([["lbernard", "pmartin"], ["lbernard", "pmartin"]]);
    await removeTeamMember(deps, admin, { teamId: "equipe-rd", uid: "pmartin" });
    expect((await getTeamPage(deps, admin, "equipe-rd")).members).toEqual(["lbernard"]);
  });

  test("il fait sortir un membre de son équipe, avec révocation de ses clés de l'équipe ; ajout direct, désignation, renommage et suppression restent aux admins", async () => {
    const cle = await cleEmise("pmartin", "equipe-rd", "R&D");
    await removeTeamMember(deps, responsable, { teamId: "equipe-rd", uid: "pmartin" });
    expect((await testDb.accessRequest.findUniqueOrThrow({ where: { id: cle.id } })).status).toBe("REVOQUEE");
    expect((await litellm.getTeam("equipe-rd"))?.memberUids).toEqual(["lbernard"]);
    await expect(removeTeamMember(deps, responsable, { teamId: "equipe-data", uid: "jdupont" })).rejects.toMatchObject({ code: "introuvable" });
    await expect(addTeamMember(deps, responsable, { teamId: "equipe-rd", uid: "pmartin" })).rejects.toMatchObject({ code: "interdit" });
    await expect(designateManager(deps, responsable, { teamId: "equipe-rd", uid: "pmartin" })).rejects.toMatchObject({ code: "interdit" });
    await expect(renameTeam(deps, responsable, { teamId: "equipe-rd", name: "Recherche" })).rejects.toMatchObject({ code: "interdit" });
    await expect(deleteTeam(deps, responsable, "equipe-rd")).rejects.toMatchObject({ code: "interdit" });
  });
});
