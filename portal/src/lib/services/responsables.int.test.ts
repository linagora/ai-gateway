import { beforeEach, describe, expect, test } from "vitest";
import { resetDb, testDb } from "@/test/db";
import { FakeLiteLLM } from "@/test/fake-litellm";
import { FakeMailer } from "@/test/fake-mailer";
import { countAdminPending, getRequestReview, listPendingRequests, listProcessedRequests } from "./admin-requests";
import { saveCatalogEntry } from "./catalog";
import { listAllKeys, listKeysToPickUp } from "./keys";
import { createKeyRequest, createTeamJoinRequest } from "./requests";
import { getTeamPage, listTeamOverviews } from "./teams";

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
    expect(equipes(await listProcessedRequests(deps, responsable))).toEqual(["R&D"]);
    expect(equipes(await listKeysToPickUp(deps, responsable))).toEqual(["R&D"]);
    expect((await listTeamOverviews(deps, responsable)).map((t) => t.teamAlias)).toEqual(["R&D"]);
    expect(equipes(await listPendingRequests(deps, admin)).sort()).toEqual(["Data", "R&D"]);
    expect((await listTeamOverviews(deps, admin)).map((t) => t.teamAlias)).toEqual(["Data", "R&D"]);
  });

  test("les clés actives d'une autre équipe ne sont pas montrées au responsable", async () => {
    await demande("pmartin", "equipe-rd", "R&D", "CLE_EMISE");
    await demande("jdupont", "equipe-data", "Data", "CLE_EMISE");
    expect((await listAllKeys(deps, responsable)).map((k) => k.teamAlias)).toEqual(["R&D"]);
    expect((await listAllKeys(deps, admin)).map((k) => k.teamAlias).sort()).toEqual(["Data", "R&D"]);
  });

  test("la pastille d'un responsable compte les demandes à valider de ses équipes, hors les siennes", async () => {
    await demande("pmartin", "equipe-rd", "R&D");
    await demande("lbernard", "equipe-rd", "R&D");
    await demande("jdupont", "equipe-data", "Data");
    await demande("pmartin", "equipe-rd", "R&D", "APPROUVEE");
    expect(await countAdminPending(deps, responsable)).toEqual({ demandes: 1, clesARetirer: 1 });
    expect(await countAdminPending(deps, admin)).toEqual({ demandes: 3, clesARetirer: 1 });
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
