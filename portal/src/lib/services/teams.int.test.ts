import { beforeEach, describe, expect, test } from "vitest";
import { resetDb, testDb } from "@/test/db";
import { FakeLiteLLM } from "@/test/fake-litellm";
import { FakeMailer } from "@/test/fake-mailer";
import { listAudit } from "./audit";
import { runDailyTask } from "./echeances";
import { addTeamMember, approversByTeam, createTeam, deleteTeam, designateManager, getTeamOverview, getTeamPage, listTeamOverviews, removeManager, removeTeamMember, renameTeam, setTeamBudget } from "./teams";

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
    expect(await getTeamOverview(deps, admin, teamId)).toEqual({
      teamId,
      teamAlias: "Data Science",
      memberCount: 0,
      activeKeyCount: 0,
      managerUids: [],
      budget: { max: null, period: null, spend: 0, resetAt: null },
    });
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

  test("la sortie d'une équipe laisse acceptée la demande d'accès qui y avait fait entrer le membre", async () => {
    litellm.users.set("pmartin", { email: "pmartin@linagora.com" });
    const acceptee = await testDb.accessRequest.create({
      data: { kind: "ADHESION_EQUIPE", status: "APPROUVEE", requesterUid: "pmartin", requesterEmail: "pmartin@linagora.com", teamId: "equipe-rd", teamAlias: "R&D", models: [], justification: "Rejoindre l'équipe" },
    });
    await removeTeamMember(deps, admin, { teamId: "equipe-rd", uid: "pmartin" });
    expect((await testDb.accessRequest.findUniqueOrThrow({ where: { id: acceptee.id } })).status).toBe("APPROUVEE");
    expect(mailer.outbox[0].text).not.toContain("Demandes annulées");
  });

  test("seul un admin ajoute ou fait sortir un membre ; faire sortir un non-membre est refusé", async () => {
    await expect(addTeamMember(deps, salarie, { teamId: "equipe-rd", uid: "lbernard" })).rejects.toMatchObject({ code: "interdit" });
    await expect(removeTeamMember(deps, salarie, { teamId: "equipe-rd", uid: "pmartin" })).rejects.toMatchObject({ code: "interdit" });
    await expect(removeTeamMember(deps, admin, { teamId: "equipe-rd", uid: "lbernard" })).rejects.toMatchObject({ code: "introuvable" });
  });
});

describe("supprimer une équipe (ticket #38)", () => {
  test("la suppression est refusée tant que l'équipe a des clés actives ou des demandes en cours, clés approuvées non retirées comprises", async () => {
    await cleEmise("mmaudet", "equipe-rd", "R&D", "mmaudet-r-d-cle-1");
    for (const status of ["SOUMISE", "APPROUVEE"] as const) {
      await testDb.accessRequest.create({ data: { kind: "CLE", status, requesterUid: "pmartin", requesterEmail: "pmartin@linagora.com", teamId: "equipe-rd", teamAlias: "R&D", dataLevel: "N1", models: ["mistral-small"], justification: "Essai" } });
    }
    await expect(deleteTeam(deps, admin, "equipe-rd")).rejects.toMatchObject({ code: "equipe_non_vide", params: { cles: "1", demandes: "2" } });
    expect(litellm.teams.has("equipe-rd")).toBe(true);
    expect(mailer.outbox).toEqual([]);
  });

  test("une équipe sans clé active ni demande en cours est supprimée de la passerelle ; ses demandes passées restent ; la suppression est inscrite et annoncée", async () => {
    const passee = await testDb.accessRequest.create({ data: { kind: "CLE", status: "REVOQUEE", requesterUid: "mmaudet", requesterEmail: "mmaudet@linagora.com", teamId: "equipe-rd", teamAlias: "R&D", dataLevel: "N1", models: ["mistral-small"], justification: "Essai" } });
    await deleteTeam(deps, admin, "equipe-rd");
    expect(litellm.teams.has("equipe-rd")).toBe(false);
    expect((await testDb.accessRequest.findUniqueOrThrow({ where: { id: passee.id } })).teamAlias).toBe("R&D");
    expect((await listAudit(testDb)).at(-1)).toMatchObject({ action: "TEAM_DELETED", targetId: "equipe-rd", details: { equipe: "R&D" } });
    expect(mailer.outbox.map((m) => [m.to, m.subject])).toEqual([[ADMINS, "[AI GATEWAY] Équipe supprimée : R&D / Team deleted: R&D"]]);
    expect(mailer.outbox[0].text).toContain("Jeanne Dupont (jdupont) a supprimé l'équipe R&D.");
  });

  test("une demande d'accès acceptée n'est plus en cours : elle ne bloque pas la suppression et reste acceptée", async () => {
    const acceptee = await testDb.accessRequest.create({
      data: { kind: "ADHESION_EQUIPE", status: "APPROUVEE", requesterUid: "pmartin", requesterEmail: "pmartin@linagora.com", teamId: "equipe-rd", teamAlias: "R&D", models: [], justification: "Rejoindre l'équipe" },
    });
    await deleteTeam(deps, admin, "equipe-rd");
    expect(litellm.teams.has("equipe-rd")).toBe(false);
    expect((await testDb.accessRequest.findUniqueOrThrow({ where: { id: acceptee.id } })).status).toBe("APPROUVEE");
  });

  test("seul un admin supprime une équipe", async () => {
    await expect(deleteTeam(deps, salarie, "equipe-rd")).rejects.toMatchObject({ code: "interdit" });
  });
});

describe("responsables d'équipe (ticket #39)", () => {
  const connu = (uid: string) => litellm.users.set(uid, { email: `${uid}@linagora.com` });

  test("un admin désigne un responsable : il devient membre s'il ne l'était pas et reçoit un courriel ; les admins sont prévenus ; la page et la liste le montrent", async () => {
    connu("lbernard");
    await designateManager(deps, admin, { teamId: "equipe-rd", uid: "lbernard" });
    const page = await getTeamPage(deps, admin, "equipe-rd");
    expect(page.members).toEqual(["lbernard", "mmaudet", "pmartin"]);
    expect(page.managers).toEqual([{ uid: "lbernard", email: "lbernard@linagora.com" }]);
    expect((await listTeamOverviews(deps, admin)).find((t) => t.teamId === "equipe-rd")?.managerUids).toEqual(["lbernard"]);
    expect(mailer.outbox.map((m) => [m.to, m.subject])).toEqual([
      [["lbernard@linagora.com"], "[AI GATEWAY] Vous êtes responsable de l'équipe R&D / You are a manager of the team R&D"],
      [ADMINS, "[AI GATEWAY] Responsable désigné pour l'équipe R&D : lbernard / Manager designated for the team R&D: lbernard"],
    ]);
    expect((await listAudit(testDb)).map((e) => e.action)).toEqual(["MEMBER_ADDED", "MANAGER_DESIGNATED"]);
  });

  test("les changements dans une équipe sont aussi annoncés à ses responsables, sauf à leur auteur", async () => {
    connu("mmaudet");
    connu("pmartin");
    await designateManager(deps, admin, { teamId: "equipe-rd", uid: "mmaudet" });
    mailer.outbox.length = 0;
    await designateManager(deps, admin, { teamId: "equipe-rd", uid: "pmartin" });
    // Le nouveau responsable reçoit sa désignation ; le changement va aux admins et à l'autre responsable.
    expect(mailer.outbox.map((m) => m.to)).toEqual([["pmartin@linagora.com"], [...ADMINS, "mmaudet@linagora.com"]]);
    mailer.outbox.length = 0;
    await renameTeam(deps, admin, { teamId: "equipe-rd", name: "Recherche" });
    expect(mailer.outbox.map((m) => m.to)).toEqual([[...ADMINS, "mmaudet@linagora.com", "pmartin@linagora.com"]]);
    mailer.outbox.length = 0;
    // Un responsable auteur d'un changement ne s'en voit pas notifier.
    await renameTeam(deps, { ...admin, uid: "mmaudet", email: "mmaudet@linagora.com", name: "Michel-Marie Maudet" }, { teamId: "equipe-rd", name: "R&D" });
    expect(mailer.outbox.map((m) => m.to)).toEqual([[...ADMINS, "pmartin@linagora.com"]]);
  });

  test("le retrait du rôle laisse le responsable membre ; sa sortie de l'équipe lui retire le rôle ; une équipe supprimée n'a plus de responsable", async () => {
    connu("mmaudet");
    connu("pmartin");
    await designateManager(deps, admin, { teamId: "equipe-rd", uid: "mmaudet" });
    await designateManager(deps, admin, { teamId: "equipe-rd", uid: "pmartin" });
    await removeManager(deps, admin, { teamId: "equipe-rd", uid: "mmaudet" });
    expect((await getTeamPage(deps, admin, "equipe-rd")).managers.map((m) => m.uid)).toEqual(["pmartin"]);
    expect((await getTeamPage(deps, admin, "equipe-rd")).members).toContain("mmaudet");
    expect(mailer.outbox.at(-1)?.subject).toBe("[AI GATEWAY] Rôle de responsable retiré dans l'équipe R&D : mmaudet / Manager role withdrawn in the team R&D: mmaudet");
    expect(mailer.outbox.at(-1)?.to).toEqual([...ADMINS, "mmaudet@linagora.com", "pmartin@linagora.com"]);
    await removeTeamMember(deps, admin, { teamId: "equipe-rd", uid: "pmartin" });
    expect((await getTeamPage(deps, admin, "equipe-rd")).managers).toEqual([]);
    await designateManager(deps, admin, { teamId: "equipe-rd", uid: "mmaudet" });
    await deleteTeam(deps, admin, "equipe-rd");
    expect(await testDb.teamManager.count()).toBe(0);
  });

  test("un uid inconnu, un responsable déjà désigné, ou le retrait d'un non-responsable sont refusés ; seul un admin désigne", async () => {
    connu("mmaudet");
    await expect(designateManager(deps, admin, { teamId: "equipe-rd", uid: "inconnu" })).rejects.toMatchObject({ code: "salarie_inconnu" });
    await designateManager(deps, admin, { teamId: "equipe-rd", uid: "mmaudet" });
    await expect(designateManager(deps, admin, { teamId: "equipe-rd", uid: "mmaudet" })).rejects.toMatchObject({ code: "responsable_existant", params: { uid: "mmaudet", equipe: "R&D" } });
    await expect(removeManager(deps, admin, { teamId: "equipe-rd", uid: "pmartin" })).rejects.toMatchObject({ code: "introuvable" });
    await expect(designateManager(deps, salarie, { teamId: "equipe-rd", uid: "pmartin" })).rejects.toMatchObject({ code: "interdit" });
  });

  test("les valideurs d'une équipe sont ses responsables, sinon personne (les admins valident)", async () => {
    connu("mmaudet");
    litellm.withTeam({ teamId: "equipe-data", teamAlias: "Data", models: [], memberUids: [] });
    await designateManager(deps, admin, { teamId: "equipe-rd", uid: "mmaudet" });
    expect(await approversByTeam(testDb, ["equipe-rd", "equipe-data"])).toEqual(new Map([["equipe-rd", ["mmaudet"]], ["equipe-data", []]]));
  });
});

describe("budget d'équipe et alertes (ticket #43)", () => {
  test("un admin fixe le budget d'équipe et sa période ; 0 le retire ; chaque changement est inscrit et annoncé", async () => {
    await setTeamBudget(deps, admin, { teamId: "equipe-rd", budget: 100, period: "30d" });
    expect(litellm.teams.get("equipe-rd")).toMatchObject({ maxBudget: 100, budgetDuration: "30d" });
    expect((await getTeamPage(deps, admin, "equipe-rd")).budget).toMatchObject({ max: 100, period: "30d", spend: 0 });
    expect((await listAudit(testDb)).at(-1)).toMatchObject({ action: "TEAM_BUDGET_SET", targetId: "equipe-rd", details: { budget: 100, periode: "30d" } });
    expect(mailer.outbox.at(-1)?.subject).toMatch(/^\[AI GATEWAY\] Budget de l'équipe R&D : 100,00\s€ par période de 30 jours \/ Budget of the team R&D: €100\.00 every 30 days$/);
    await setTeamBudget(deps, admin, { teamId: "equipe-rd", budget: 0, period: "" });
    expect(litellm.teams.get("equipe-rd")).toMatchObject({ maxBudget: null, budgetDuration: null });
    expect((await listTeamOverviews(deps, admin)).find((t) => t.teamId === "equipe-rd")?.budget).toMatchObject({ max: null, period: null });
    expect(mailer.outbox.at(-1)?.subject).toBe("[AI GATEWAY] Budget de l'équipe R&D : sans limite / Budget of the team R&D: no limit");
    expect(mailer.outbox.at(-1)?.to).toEqual(ADMINS);
  });

  test("un budget négatif, ou positif sans période valide, est refusé ; seul un admin fixe le budget", async () => {
    await expect(setTeamBudget(deps, admin, { teamId: "equipe-rd", budget: -5, period: "30d" })).rejects.toMatchObject({ code: "budget_equipe_invalide" });
    await expect(setTeamBudget(deps, admin, { teamId: "equipe-rd", budget: 50, period: "un mois" })).rejects.toMatchObject({ code: "budget_equipe_invalide" });
    await expect(setTeamBudget(deps, salarie, { teamId: "equipe-rd", budget: 50, period: "30d" })).rejects.toMatchObject({ code: "interdit" });
    expect(litellm.teams.get("equipe-rd")).toMatchObject({ maxBudget: null });
  });

  test("la tâche quotidienne alerte les admins et les responsables à 80 %, puis à 100 %, une seule fois par période ; jamais sans budget", async () => {
    litellm.users.set("mmaudet", { email: "mmaudet@linagora.com" });
    litellm.withTeam({ teamId: "equipe-data", teamAlias: "Data", models: [], memberUids: [], maxBudget: 50, budgetDuration: "30d", spend: 45, budgetResetAt: new Date("2026-10-31T00:00:00Z") });
    await designateManager(deps, admin, { teamId: "equipe-data", uid: "mmaudet" });
    // Sans budget, R&D n'est jamais alertée, quelle que soit sa dépense.
    litellm.teams.get("equipe-rd")!.spend = 999;
    mailer.outbox.length = 0;
    const tache = () => runDailyTask({ ...deps, now: () => new Date("2026-10-15T05:00:00Z") });

    expect((await tache()).alertesBudget).toBe(1);
    expect(mailer.outbox.map((m) => [m.to, m.subject])).toEqual([
      [[...ADMINS, "mmaudet@linagora.com"], "[AI GATEWAY] Budget de l'équipe Data atteint à 80 % / Budget of the team Data 80% used"],
    ]);
    expect(mailer.outbox[0].text).toMatch(/L'équipe Data a dépensé 45,00\s€ sur son budget de 50,00\s€ pour la période qui s'achève le 31 octobre 2026\./);
    expect((await tache()).alertesBudget).toBe(0);

    litellm.teams.get("equipe-data")!.spend = 50;
    expect((await tache()).alertesBudget).toBe(1);
    expect(mailer.outbox.at(-1)?.subject).toBe("[AI GATEWAY] Budget de l'équipe Data atteint à 100 % / Budget of the team Data 100% used");
    expect(mailer.outbox.at(-1)?.text).toContain("Ses clés sont refusées par la passerelle jusqu'à cette date.");
    expect((await tache()).alertesBudget).toBe(0);

    // Nouvelle période : les alertes repartent.
    Object.assign(litellm.teams.get("equipe-data")!, { spend: 42, budgetResetAt: new Date("2026-11-30T00:00:00Z") });
    expect((await tache()).alertesBudget).toBe(1);
    expect(mailer.outbox.at(-1)?.subject).toBe("[AI GATEWAY] Budget de l'équipe Data atteint à 80 % / Budget of the team Data 80% used");
  });

  test("une passerelle injoignable n'empêche pas le reste de la tâche quotidienne", async () => {
    litellm.panne = true;
    expect(await runDailyTask({ ...deps, now: () => new Date("2026-10-15T05:00:00Z") })).toMatchObject({ alertesBudget: 0 });
  });
});
