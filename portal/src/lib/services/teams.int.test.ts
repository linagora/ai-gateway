import { beforeEach, describe, expect, test } from "vitest";
import { resetDb, testDb } from "@/test/db";
import { FakeLiteLLM } from "@/test/fake-litellm";
import { FakeMailer } from "@/test/fake-mailer";
import { listAudit } from "./audit";
import { addTeamMember, createTeam, getTeamOverview, getTeamPage, listTeamOverviews, removeTeamMember, renameTeam } from "./teams";

const admin = { uid: "jdupont", email: "jdupont@linagora.com", name: "Jeanne Dupont", isAdmin: true };
const salarie = { uid: "mmaudet", email: "mmaudet@linagora.com", name: "Michel-Marie Maudet", isAdmin: false };
const ADMINS = ["jdupont@linagora.com", "admin2@linagora.com"];

let litellm: FakeLiteLLM;
let mailer: FakeMailer;
let deps: { db: typeof testDb; litellm: FakeLiteLLM; mailer: FakeMailer; adminEmails: string[]; portalUrl: string };

beforeEach(async () => {
  await resetDb();
  litellm = new FakeLiteLLM().withTeam({ teamId: "equipe-rd", teamAlias: "R&D", models: [], memberUids: ["mmaudet", "pmartin"] });
  mailer = new FakeMailer();
  deps = { db: testDb, litellm, mailer, adminEmails: ADMINS, portalUrl: "https://portail.test" };
});

describe("créer, renommer et lister les équipes (ticket #36)", () => {
  test("un admin crée une équipe : elle existe dans la passerelle, sans membre ni clé ; la création est inscrite au journal et annoncée aux admins", async () => {
    const teamId = await createTeam(deps, admin, { name: "  Data Science  " });
    expect(await getTeamOverview(deps, admin, teamId)).toEqual({ teamId, teamAlias: "Data Science", memberCount: 0, activeKeyCount: 0 });
    expect(await listAudit(testDb)).toEqual([expect.objectContaining({ actorUid: "jdupont", action: "TEAM_CREATED", targetId: teamId, details: { equipe: "Data Science" } })]);
    expect(mailer.outbox).toEqual([
      expect.objectContaining({ to: ADMINS, subject: "[AI GATEWAY] Équipe créée : Data Science / Team created: Data Science" }),
    ]);
    expect(mailer.outbox[0].text).toContain("Jeanne Dupont (jdupont) a créé l'équipe Data Science.");
    expect(mailer.outbox[0].text).toContain(`https://portail.test/gestion/equipes/${teamId}`);
  });

  test("un nom vide, ou déjà pris avec d'autres majuscules, est refusé", async () => {
    await expect(createTeam(deps, admin, { name: "   " })).rejects.toMatchObject({ code: "nom_equipe_invalide" });
    await expect(createTeam(deps, admin, { name: "r&d" })).rejects.toMatchObject({ code: "nom_equipe_pris", params: { nom: "R&D" } });
    expect(litellm.teams.size).toBe(1);
  });

  test("un admin renomme une équipe ; le nouveau nom reste unique, mais changer ses seules majuscules est permis", async () => {
    const teamId = await createTeam(deps, admin, { name: "Data" });
    await expect(renameTeam(deps, admin, { teamId, name: "R&D" })).rejects.toMatchObject({ code: "nom_equipe_pris" });
    await renameTeam(deps, admin, { teamId, name: "DATA" });
    await renameTeam(deps, admin, { teamId, name: "Data Science" });
    expect((await getTeamOverview(deps, admin, teamId)).teamAlias).toBe("Data Science");
    expect((await listAudit(testDb)).at(-1)).toMatchObject({ action: "TEAM_RENAMED", targetId: teamId, details: { ancienNom: "DATA", nouveauNom: "Data Science" } });
    expect(mailer.outbox.at(-1)?.text).toContain("Jeanne Dupont (jdupont) a renommé l'équipe DATA en Data Science.");
  });

  test("la liste donne, pour chaque équipe, ses membres réels et ses clés actives, par ordre alphabétique", async () => {
    await createTeam(deps, admin, { name: "Communication" });
    await testDb.accessRequest.create({
      data: {
        kind: "CLE", status: "CLE_EMISE", requesterUid: "mmaudet", requesterEmail: "mmaudet@linagora.com", teamId: "equipe-rd", teamAlias: "R&D",
        dataLevel: "N1", models: ["mistral-small"], justification: "Essai", keyAlias: "mmaudet-r-d-cle-abcd", keyTokenId: "empreinte", keyIssuedAt: new Date(),
      },
    });
    expect((await listTeamOverviews(deps, admin)).map((t) => [t.teamAlias, t.memberCount, t.activeKeyCount])).toEqual([
      ["Communication", 0, 0],
      ["R&D", 2, 1],
    ]);
  });

  test("un salarié ne peut ni lister, ni créer, ni renommer d'équipe", async () => {
    await expect(listTeamOverviews(deps, salarie)).rejects.toMatchObject({ code: "interdit" });
    await expect(createTeam(deps, salarie, { name: "Pirates" })).rejects.toMatchObject({ code: "interdit" });
    await expect(renameTeam(deps, salarie, { teamId: "equipe-rd", name: "Pirates" })).rejects.toMatchObject({ code: "interdit" });
  });

  test("une équipe inconnue est introuvable", async () => {
    await expect(getTeamOverview(deps, admin, "equipe-inconnue")).rejects.toMatchObject({ code: "introuvable" });
    await expect(renameTeam(deps, admin, { teamId: "equipe-inconnue", name: "Nouveau nom" })).rejects.toMatchObject({ code: "introuvable" });
  });
});

/** Clé émise dans la passerelle simulée, et sa demande dans le portail. */
async function cleEmise(uid: string, teamId: string, teamAlias: string, alias: string) {
  const { tokenId } = await litellm.generateKey({
    userId: uid, teamId, models: ["mistral-small"], maxBudget: 5, budgetDuration: "30d", duration: "30d", rpmLimit: null, tpmLimit: null, alias, metadata: {},
  });
  return testDb.accessRequest.create({
    data: {
      kind: "CLE", status: "CLE_EMISE", requesterUid: uid, requesterEmail: `${uid}@linagora.com`, teamId, teamAlias, dataLevel: "N1",
      models: ["mistral-small"], approvedModels: ["mistral-small"], justification: "Essai", keyAlias: alias, keyTokenId: tokenId, keyIssuedAt: new Date(),
    },
  });
}

describe("membres d'une équipe : ajout direct et sortie d'une équipe (ticket #37)", () => {
  test("un admin ajoute directement un salarié déjà connecté : il devient membre et reçoit un courriel ; les admins sont prévenus", async () => {
    litellm.users.set("lbernard", { email: "lbernard@linagora.com" });
    await addTeamMember(deps, admin, { teamId: "equipe-rd", uid: " lbernard " });
    expect((await getTeamPage(deps, admin, "equipe-rd")).members).toEqual(["lbernard", "mmaudet", "pmartin"]);
    expect(mailer.outbox.map((m) => [m.to, m.subject])).toEqual([
      [["lbernard@linagora.com"], "[AI GATEWAY] Vous êtes membre de l'équipe R&D / You are a member of the team R&D"],
      [ADMINS, "[AI GATEWAY] Membre ajouté à l'équipe R&D : lbernard / Member added to the team R&D: lbernard"],
    ]);
    expect(mailer.outbox[0].text).toContain("Jeanne Dupont (jdupont) vous a ajouté à l'équipe R&D : vous pouvez y demander une clé d'API.");
    expect((await listAudit(testDb)).at(-1)).toMatchObject({ action: "MEMBER_ADDED", targetId: "equipe-rd", details: { membre: "lbernard" } });
  });

  test("l'ajout d'un uid qui ne s'est jamais connecté, ou d'un membre existant, est refusé", async () => {
    await expect(addTeamMember(deps, admin, { teamId: "equipe-rd", uid: "inconnu" })).rejects.toMatchObject({ code: "salarie_inconnu", params: { uid: "inconnu" } });
    litellm.users.set("pmartin", { email: "pmartin@linagora.com" });
    await expect(addTeamMember(deps, admin, { teamId: "equipe-rd", uid: "pmartin" })).rejects.toMatchObject({ code: "membre_existant", params: { uid: "pmartin", equipe: "R&D" } });
    expect(mailer.outbox).toEqual([]);
  });

  test("la sortie d'une équipe révoque les seules clés du membre dans cette équipe, annule ses demandes en cours dans l'équipe et le prévient", async () => {
    litellm.users.set("mmaudet", { email: "mmaudet@linagora.com" });
    litellm.withTeam({ teamId: "equipe-data", teamAlias: "Data", models: [], memberUids: ["mmaudet"] });
    const cleRd = await cleEmise("mmaudet", "equipe-rd", "R&D", "mmaudet-r-d-cle-1");
    const cleData = await cleEmise("mmaudet", "equipe-data", "Data", "mmaudet-data-cle-2");
    const cleCollegue = await cleEmise("pmartin", "equipe-rd", "R&D", "pmartin-r-d-cle-3");
    const enCours = await Promise.all(
      (["SOUMISE", "A_COMPLETER", "APPROUVEE"] as const).map((status) =>
        testDb.accessRequest.create({ data: { kind: "CLE", status, requesterUid: "mmaudet", requesterEmail: "mmaudet@linagora.com", teamId: "equipe-rd", teamAlias: "R&D", dataLevel: "N1", models: ["mistral-small"], justification: "Essai" } }),
      ),
    );

    await removeTeamMember(deps, admin, { teamId: "equipe-rd", uid: "mmaudet" });

    expect((await getTeamPage(deps, admin, "equipe-rd")).members).toEqual(["pmartin"]);
    const statut = async (id: string) => (await testDb.accessRequest.findUniqueOrThrow({ where: { id } })).status;
    expect(await statut(cleRd.id)).toBe("REVOQUEE");
    expect(litellm.keys.has(cleRd.keyTokenId!)).toBe(false);
    expect(await statut(cleData.id)).toBe("CLE_EMISE");
    expect(await statut(cleCollegue.id)).toBe("CLE_EMISE");
    expect(await Promise.all(enCours.map((r) => statut(r.id)))).toEqual(["ANNULEE", "ANNULEE", "ANNULEE"]);
    expect(mailer.outbox.map((m) => [m.to, m.subject])).toEqual([
      [["mmaudet@linagora.com"], "[AI GATEWAY] Vous ne faites plus partie de l'équipe R&D / You are no longer a member of the team R&D"],
      [ADMINS, "[AI GATEWAY] Membre sorti de l'équipe R&D : mmaudet / Member removed from the team R&D: mmaudet"],
    ]);
    expect(mailer.outbox[0].text).toContain("Jeanne Dupont (jdupont) vous a fait sortir de l'équipe R&D. Clés révoquées : mmaudet-r-d-cle-1. Demandes annulées : 3.");
    expect((await listAudit(testDb)).map((e) => e.action)).toEqual(["KEY_REVOKED", "MEMBER_REMOVED"]);
  });

  test("seul un admin ajoute ou fait sortir un membre ; faire sortir un non-membre est refusé", async () => {
    await expect(addTeamMember(deps, salarie, { teamId: "equipe-rd", uid: "lbernard" })).rejects.toMatchObject({ code: "interdit" });
    await expect(removeTeamMember(deps, salarie, { teamId: "equipe-rd", uid: "pmartin" })).rejects.toMatchObject({ code: "interdit" });
    await expect(removeTeamMember(deps, admin, { teamId: "equipe-rd", uid: "lbernard" })).rejects.toMatchObject({ code: "introuvable" });
  });
});
