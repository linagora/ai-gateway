import { beforeEach, describe, expect, test } from "vitest";
import { resetDb, testDb } from "@/test/db";
import { FakeLiteLLM } from "@/test/fake-litellm";
import { FakeMailer } from "@/test/fake-mailer";
import { listAudit } from "./audit";
import { createTeam, getTeamOverview, listTeamOverviews, renameTeam } from "./teams";

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
