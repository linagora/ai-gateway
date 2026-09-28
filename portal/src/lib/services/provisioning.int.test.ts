import { beforeEach, describe, expect, test } from "vitest";
import { resetDb, testDb } from "@/test/db";
import { FakeLiteLLM } from "@/test/fake-litellm";
import { listAudit } from "./audit";
import { provisionIntegrationUser } from "./provisioning";
import { createTeamJoinRequest } from "./requests";

/*
 * Garde-fou d'identité (spécification #71, ticket #76) : au premier accès par une intégration, un uid encore inconnu (ni
 * utilisateur de la passerelle, ni trace dans le portail) dont l'adresse appartient déjà à un autre uid est refusé et
 * inscrit au journal d'audit, sans provisionnement ; sinon, le collaborateur est provisionné comme à sa connexion.
 */
const parTeamManager = (uid: string, email: string) => ({ uid, email, name: uid, isAdmin: false, canal: "team-manager" });

let litellm: FakeLiteLLM;
let deps: { db: typeof testDb; litellm: FakeLiteLLM };

beforeEach(async () => {
  await resetDb();
  litellm = new FakeLiteLLM().withTeam({ teamId: "equipe-rd", teamAlias: "R&D", models: [], memberUids: [] });
  deps = { db: testDb, litellm };
});

const refusee = (uid: string, email: string) => expect(provisionIntegrationUser(deps, parTeamManager(uid, email))).rejects.toMatchObject({ code: "identite_incoherente" });

describe("provisionnement par une intégration", () => {
  test("un uid inconnu dont l'adresse n'est connue nulle part est provisionné, sans rien inscrire au journal", async () => {
    await provisionIntegrationUser(deps, parTeamManager("pmartin", "pmartin@linagora.com"));
    expect((await litellm.getUser("pmartin"))?.email).toBe("pmartin@linagora.com");
    expect(await listAudit(testDb)).toEqual([]);
  });

  test("des premiers accès simultanés d'un même collaborateur aboutissent tous, sans refus inscrit au journal", async () => {
    // Une intégration peut lancer plusieurs appels en parallèle au premier accès d'un collaborateur.
    await Promise.all([
      provisionIntegrationUser(deps, parTeamManager("pmartin", "pmartin@linagora.com")),
      provisionIntegrationUser(deps, parTeamManager("pmartin", "pmartin@linagora.com")),
    ]);
    expect((await litellm.getUser("pmartin"))?.email).toBe("pmartin@linagora.com");
    expect(await listAudit(testDb)).toEqual([]);
  });

  test("un uid inconnu dont l'adresse appartient à un utilisateur de la passerelle est refusé, sans provisionnement, et inscrit au journal avec son canal", async () => {
    await litellm.createUser({ userId: "mmaudet", email: "mmaudet@linagora.com" });
    await refusee("MMaudet", "MMaudet@Linagora.com");
    expect(await litellm.getUser("MMaudet")).toBeNull();
    expect(await listAudit(testDb)).toEqual([
      expect.objectContaining({
        actorUid: "MMaudet",
        action: "INTEGRATION_IDENTITY_REFUSED",
        details: { email: "MMaudet@Linagora.com", uidExistants: "mmaudet", canal: "team-manager" },
      }),
    ]);
  });

  test("un uid inconnu dont l'adresse appartient, dans le portail, à l'auteur d'une demande ou à un responsable est refusé", async () => {
    // L'auteur d'une demande dont l'utilisateur de la passerelle a disparu, et un responsable jamais connecté.
    await litellm.createUser({ userId: "lbernard", email: "lbernard@linagora.com" });
    await createTeamJoinRequest(deps, { uid: "lbernard", email: "lbernard@linagora.com", name: "Lise Bernard", isAdmin: false }, { teamId: "equipe-rd", justification: "Rejoindre R&D" });
    litellm.users.delete("lbernard");
    await testDb.teamManager.create({ data: { teamId: "equipe-rd", uid: "jdupont", email: "jdupont@linagora.com", designatedBy: "mmaudet" } });
    await refusee("lise.bernard", "lbernard@linagora.com");
    await refusee("jeanne.dupont", "JDupont@linagora.com");
    expect((await listAudit(testDb)).filter((e) => e.action === "INTEGRATION_IDENTITY_REFUSED").map((e) => e.details.uidExistants)).toEqual(["lbernard", "jdupont"]);
  });

  test("un uid déjà connu, de la passerelle ou du portail, passe sans contrôle de son adresse", async () => {
    await litellm.createUser({ userId: "mmaudet", email: "mmaudet@linagora.com" });
    await litellm.createUser({ userId: "pmartin", email: "pmartin@linagora.com" });
    // Connu de la passerelle : rien ne change, même si l'adresse du jeton appartient à un autre uid.
    await provisionIntegrationUser(deps, parTeamManager("pmartin", "mmaudet@linagora.com"));
    expect((await litellm.getUser("pmartin"))?.email).toBe("pmartin@linagora.com");
    // Connu du portail seulement (demande déposée, utilisateur de la passerelle disparu) : provisionné de nouveau, même si
    // son adresse est celle d'un responsable dans le portail.
    await testDb.teamManager.create({ data: { teamId: "equipe-rd", uid: "jdupont", email: "jdupont@linagora.com", designatedBy: "mmaudet" } });
    await createTeamJoinRequest(deps, { uid: "lbernard", email: "lbernard@linagora.com", name: "Lise Bernard", isAdmin: false }, { teamId: "equipe-rd", justification: "Rejoindre R&D" });
    await provisionIntegrationUser(deps, parTeamManager("lbernard", "jdupont@linagora.com"));
    expect((await litellm.getUser("lbernard"))?.email).toBe("jdupont@linagora.com");
    expect((await listAudit(testDb)).map((e) => e.action)).toEqual(["REQUEST_CREATED"]);
  });

  test("une adresse que la passerelle refuse, déjà prise par un de ses utilisateurs, est un refus d'identité", async () => {
    await litellm.createUser({ userId: "mmaudet", email: "mmaudet@linagora.com" });
    await createTeamJoinRequest(deps, { uid: "lbernard", email: "lbernard@linagora.com", name: "Lise Bernard", isAdmin: false }, { teamId: "equipe-rd", justification: "Rejoindre R&D" });
    await refusee("lbernard", "mmaudet@linagora.com");
    expect(await litellm.getUser("lbernard")).toBeNull();
    expect((await listAudit(testDb)).at(-1)).toMatchObject({ actorUid: "lbernard", action: "INTEGRATION_IDENTITY_REFUSED", details: { email: "mmaudet@linagora.com" } });
  });
});
