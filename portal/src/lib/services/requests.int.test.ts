import { beforeEach, describe, expect, test } from "vitest";
import { resetDb, testDb } from "@/test/db";
import { FakeLiteLLM } from "@/test/fake-litellm";
import { FakeMailer } from "@/test/fake-mailer";
import { saveCatalogEntry } from "./catalog";
import { pickUpKey } from "./keys";
import { provisionUser } from "./provisioning";
import { approveKeyRequest, getRequestReview, requestCompletion } from "./admin-requests";
import {
  cancelRequest,
  completeRequest,
  completionDraft,
  countMyPending,
  createKeyRequest,
  createTeamJoinRequest,
  type KeyRequestInput,
  listJoinableTeams,
  listMyRequests,
  listMyTeams,
} from "./requests";
import { saveSettings } from "./settings";

const admin = { uid: "jdupont", email: "jdupont@linagora.com", name: "Jeanne Dupont", isAdmin: true };
const demandeur = { uid: "mmaudet", email: "mmaudet@linagora.com", name: "Michel-Marie Maudet", isAdmin: false };

const entry = { shortDescriptionFr: "…", longDescriptionFr: "…", useCases: [], recommendedFor: [], visible: true };

let litellm: FakeLiteLLM;
let deps: { db: typeof testDb; litellm: FakeLiteLLM };

beforeEach(async () => {
  await resetDb();
  litellm = new FakeLiteLLM()
    .withModel({ modelName: "mistral-small" })
    .withModel({ modelName: "qwen3.8" })
    .withTeam({ teamId: "equipe-rd", teamAlias: "R&D", models: ["mistral-small", "qwen3.8"], memberUids: ["mmaudet"] });
  deps = { db: testDb, litellm };
  await saveCatalogEntry(deps, admin, { ...entry, modelName: "mistral-small", displayNameFr: "Mistral Small", dataLevel: "N2" });
  await saveCatalogEntry(deps, admin, { ...entry, modelName: "qwen3.8", displayNameFr: "Qwen 3.8", dataLevel: "N3" });
  await saveSettings(deps, admin, { default_budget: "20" });
});

const demande: KeyRequestInput = {
  teamId: "equipe-rd",
  dataLevel: "N2",
  models: ["mistral-small", "qwen3.8"],
  justification: "Assistant de rédaction des comptes rendus",
  project: "compte-rendu",
  requestedBudget: 20,
  requestedDays: 90,
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

  test("un salarié demande une clé Expérimental pour tester un modèle en bêta", async () => {
    litellm.withModel({ modelName: "modele-beta" }).withTeam({ teamId: "equipe-veille", teamAlias: "Veille", models: [], memberUids: ["mmaudet"] });
    await saveCatalogEntry(deps, admin, { ...entry, modelName: "modele-beta", displayNameFr: "Modèle bêta", dataLevel: "EXP" });
    await createKeyRequest(deps, demandeur, { ...demande, teamId: "equipe-veille", dataLevel: "EXP", models: ["modele-beta"] });
    expect(await listMyRequests(deps, demandeur)).toMatchObject([{ kind: "CLE", teamAlias: "Veille", dataLevel: "EXP", models: ["modele-beta"], status: "SOUMISE" }]);
  });

  test("une demande pour une équipe inconnue est refusée", async () => {
    await expect(createKeyRequest(deps, demandeur, { ...demande, teamId: "equipe-fantome" })).rejects.toMatchObject({ code: "introuvable" });
  });

  test("un utilisateur ne voit pas les demandes des autres", async () => {
    await createKeyRequest(deps, demandeur, demande);
    expect(await listMyRequests(deps, { ...demandeur, uid: "pmartin", email: "pmartin@linagora.com" })).toEqual([]);
  });
});

describe("équipes proposées dans les formulaires", () => {
  beforeEach(async () => {
    litellm.withTeam({ teamId: "equipe-data", teamAlias: "Data", models: ["mistral-small"], memberUids: ["jdupont"] });
    await provisionUser(deps, demandeur);
  });

  test("une demande de clé propose les équipes dont l'utilisateur est membre (F-20)", async () => {
    expect(await listMyTeams(deps, demandeur)).toEqual([{ teamId: "equipe-rd", teamAlias: "R&D", models: ["mistral-small", "qwen3.8"] }]);
  });

  test("une demande d'accès propose les autres équipes (F-22)", async () => {
    expect((await listJoinableTeams(deps, demandeur)).map((t) => t.teamId)).toEqual(["equipe-data"]);
  });
});

describe("demandes d'accès à une équipe (F-22)", () => {
  beforeEach(() => {
    litellm.withTeam({ teamId: "equipe-data", teamAlias: "Data", models: ["mistral-small"], memberUids: ["jdupont"] });
  });

  test("une demande d'accès est enregistrée et apparaît dans Mes demandes", async () => {
    await createTeamJoinRequest(deps, demandeur, { teamId: "equipe-data", justification: "Rejoindre le projet d'analyse" });
    expect(await listMyRequests(deps, demandeur)).toMatchObject([{ kind: "ADHESION_EQUIPE", teamAlias: "Data", status: "SOUMISE" }]);
  });

  test("une seconde demande d'accès à la même équipe est refusée tant que la première est en cours ; l'équipe n'est plus proposée", async () => {
    const { id } = await createTeamJoinRequest(deps, demandeur, { teamId: "equipe-data", justification: "Rejoindre le projet d'analyse" });
    await expect(createTeamJoinRequest(deps, demandeur, { teamId: "equipe-data", justification: "Relance" })).rejects.toMatchObject({
      code: "demande_en_cours",
      params: { equipe: "Data" },
    });
    expect((await listJoinableTeams(deps, demandeur)).map((t) => t.teamId)).not.toContain("equipe-data");
    await cancelRequest(deps, demandeur, id);
    expect((await listJoinableTeams(deps, demandeur)).map((t) => t.teamId)).toContain("equipe-data");
    await expect(createTeamJoinRequest(deps, demandeur, { teamId: "equipe-data", justification: "Relance" })).resolves.toMatchObject({ id: expect.any(String) });
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

  test("une demande approuvée ne s'annule plus : seule la sortie de l'équipe l'annule (F-54)", async () => {
    const { id } = await createKeyRequest(deps, demandeur, demande);
    await testDb.accessRequest.update({ where: { id }, data: { status: "APPROUVEE" } });
    await expect(cancelRequest(deps, demandeur, id)).rejects.toMatchObject({ code: "transition_interdite" });
    expect(await listMyRequests(deps, demandeur)).toMatchObject([{ id, status: "APPROUVEE" }]);
  });

  test("un autre utilisateur ne peut pas annuler la demande", async () => {
    const { id } = await createKeyRequest(deps, demandeur, demande);
    const autre = { ...demandeur, uid: "pmartin", email: "pmartin@linagora.com" };
    await expect(cancelRequest(deps, autre, id)).rejects.toMatchObject({ code: "introuvable" });
  });

  test("restreinte à certains types de demande (API d'intégration : clés et accès), l'annulation tient les autres pour introuvables", async () => {
    const { id } = await createKeyRequest(deps, demandeur, demande);
    await testDb.accessRequest.update({ where: { id }, data: { kind: "ABONNEMENT" } });
    await expect(cancelRequest(deps, demandeur, id, ["CLE", "ADHESION_EQUIPE"])).rejects.toMatchObject({ code: "introuvable" });
    await cancelRequest(deps, demandeur, id);
    expect(await listMyRequests(deps, demandeur)).toMatchObject([{ id, status: "ANNULEE" }]);
  });
});

describe("notification des admins (ticket #23)", () => {
  const ADMINS = ["jdupont@linagora.com", "pmartin@linagora.com"];
  let mailer: FakeMailer;
  const avecCourriel = () => ({ ...deps, mailer, adminEmails: ADMINS, portalUrl: "https://portail.test" });

  beforeEach(() => {
    mailer = new FakeMailer();
    litellm.withTeam({ teamId: "equipe-lps", teamAlias: "LPS Paris", models: [], memberUids: [] });
  });

  test("une nouvelle demande de clé envoie aux admins un courriel bilingue qui nomme le demandeur et récapitule sa demande", async () => {
    const { id } = await createKeyRequest(avecCourriel(), demandeur, demande);
    expect(mailer.outbox).toHaveLength(1);
    const [courriel] = mailer.outbox;
    expect(courriel.to).toEqual(ADMINS);
    expect(courriel.subject).toBe("[AI GATEWAY] Nouvelle demande de clé d'API de Michel-Marie Maudet / New API key request from Michel-Marie Maudet");
    expect(courriel.text).toContain(
      [
        "Michel-Marie Maudet (mmaudet@linagora.com) a déposé une demande de clé d'API :",
        "- Équipe : R&D",
        "- Niveau de confidentialité : N2 Interne",
        "- Modèles : mistral-small, qwen3.8",
        "- Projet : compte-rendu",
        "- Motif : Assistant de rédaction des comptes rendus",
        "- Durée souhaitée : 3 mois",
      ].join("\n"),
    );
    expect(courriel.text).toContain("Michel-Marie Maudet (mmaudet@linagora.com) submitted an API key request:\n- Team: R&D\n- Confidentiality level: N2 Internal");
    expect(courriel.text).toContain(`https://portail.test/gestion/demandes/${id}`);
    expect(courriel.text.indexOf("a déposé")).toBeLessThan(courriel.text.indexOf("submitted"));
    // Aucun tiret quadratin, pas même entre les deux langues.
    expect(courriel.text).not.toContain("—");
  });

  test("une nouvelle demande d'accès aussi", async () => {
    const { id } = await createTeamJoinRequest(avecCourriel(), demandeur, { teamId: "equipe-lps", justification: "Rejoindre mon équipe" });
    expect(mailer.outbox.map((c) => [c.to, c.subject])).toEqual([
      [ADMINS, "[AI GATEWAY] Nouvelle demande d'accès à une équipe de Michel-Marie Maudet / New team access request from Michel-Marie Maudet"],
    ]);
    expect(mailer.outbox[0].text).toContain("Michel-Marie Maudet (mmaudet@linagora.com) demande à rejoindre l'équipe LPS Paris :\n- Motif : Rejoindre mon équipe");
    expect(mailer.outbox[0].text).toContain(`https://portail.test/gestion/demandes/${id}`);
  });

  test("un échec d'envoi n'empêche pas le dépôt de la demande", async () => {
    mailer.panne = true;
    await createKeyRequest(avecCourriel(), demandeur, demande);
    expect(await listMyRequests(deps, demandeur)).toHaveLength(1);
  });

  test("sans expéditeur ou sans admin à notifier, rien n'est envoyé et rien n'est bloqué", async () => {
    await createKeyRequest({ ...avecCourriel(), adminEmails: [] }, demandeur, demande);
    await createKeyRequest(deps, demandeur, demande);
    expect(mailer.outbox).toEqual([]);
    expect(await listMyRequests(deps, demandeur)).toHaveLength(2);
  });
});

describe("pastilles du menu du salarié", () => {
  test("elles comptent ses clés approuvées à retirer et ses demandes à compléter, et rien pour un autre", async () => {
    const approuvee = await createKeyRequest(deps, demandeur, demande);
    await approveKeyRequest(deps, admin, approuvee.id, { models: ["mistral-small"], budget: 10, budgetDuration: "30d", days: 30, rpmLimit: null, tpmLimit: null });
    const aCompleter = await createKeyRequest(deps, demandeur, { ...demande, project: "à préciser" });
    await requestCompletion(deps, admin, aCompleter.id, "Précisez le projet");
    await createKeyRequest(deps, demandeur, { ...demande, project: "en attente" });
    expect(await countMyPending(deps, demandeur)).toEqual({ clesARetirer: 1, abonnementsADeclarer: 0, demandesACompleter: 1 });
    expect(await countMyPending(deps, admin)).toEqual({ clesARetirer: 0, abonnementsADeclarer: 0, demandesACompleter: 0 });
  });
});

describe("budget demandé à la création", () => {
  test("au-delà du budget par défaut, la justification du budget est obligatoire", async () => {
    await expect(createKeyRequest(deps, demandeur, { ...demande, requestedBudget: 50, budgetJustification: null })).rejects.toMatchObject({ code: "justification_budget_requise" });
    await expect(createKeyRequest(deps, demandeur, { ...demande, requestedBudget: 50, budgetJustification: "   " })).rejects.toMatchObject({ code: "justification_budget_requise" });
    const { id } = await createKeyRequest(deps, demandeur, { ...demande, requestedBudget: 50, budgetJustification: "Traitement de 2 000 contrats" });
    expect(await testDb.accessRequest.findUniqueOrThrow({ where: { id } })).toMatchObject({ budgetJustification: "Traitement de 2 000 contrats" });
    expect((await getRequestReview(deps, admin, id)).budgetJustification).toBe("Traitement de 2 000 contrats");
  });

  test("le budget demandé, puis approuvé, est arrondi au centime : un montant arrondi au budget par défaut ne se justifie pas", async () => {
    const { id } = await createKeyRequest(deps, demandeur, { ...demande, requestedBudget: 20.004, budgetJustification: null });
    expect((await getRequestReview(deps, admin, id)).requestedBudget).toBe(20);
    await approveKeyRequest(deps, admin, id, { models: ["mistral-small"], budget: 15.555, budgetDuration: "30d", days: 60, rpmLimit: null, tpmLimit: null });
    expect((await getRequestReview(deps, admin, id)).approved?.budget).toBe(15.56);
    await pickUpKey(deps, demandeur, id);
    expect([...litellm.keys.values()].map((k) => k.maxBudget)).toEqual([15.56]);
  });

  test("au budget par défaut ou en dessous, aucune justification n'est demandée, et une justification saisie n'est pas gardée", async () => {
    const { id } = await createKeyRequest(deps, demandeur, { ...demande, requestedBudget: 20, budgetJustification: "inutile" });
    expect(await testDb.accessRequest.findUniqueOrThrow({ where: { id } })).toMatchObject({ requestedBudget: expect.anything(), budgetJustification: null });
  });

  test("un renouvellement au budget de la clé d'origine ne se rejustifie pas ; au-delà, si", async () => {
    const { id: origine } = await createKeyRequest(deps, demandeur, { ...demande, requestedBudget: 50, budgetJustification: "Gros volume" });
    await approveKeyRequest(deps, admin, origine, { models: ["mistral-small"], budget: 50, budgetDuration: "30d", days: 60, rpmLimit: null, tpmLimit: null });
    await pickUpKey(deps, demandeur, origine);
    const renouvellement = { ...demande, renewsRequestId: origine, budgetJustification: null };
    await expect(createKeyRequest(deps, demandeur, { ...renouvellement, requestedBudget: 60 })).rejects.toMatchObject({ code: "justification_budget_requise" });
    const { id } = await createKeyRequest(deps, demandeur, { ...renouvellement, requestedBudget: 50 });
    expect(await testDb.accessRequest.findUniqueOrThrow({ where: { id } })).toMatchObject({ renewsRequestId: origine, budgetJustification: null });
  });

  test("un complément peut changer le budget et sa justification", async () => {
    const { id } = await createKeyRequest(deps, demandeur, { ...demande, requestedBudget: 50, budgetJustification: "Traitement de 2 000 contrats" });
    await requestCompletion(deps, admin, id, "Précisez le volume");
    await expect(completeRequest(deps, demandeur, id, { ...demande, requestedBudget: 80, budgetJustification: null })).rejects.toMatchObject({ code: "justification_budget_requise" });
    await completeRequest(deps, demandeur, id, { ...demande, requestedBudget: 80, budgetJustification: "Volume revu à 4 000 contrats" });
    const demandeComplete = await testDb.accessRequest.findUniqueOrThrow({ where: { id } });
    expect(demandeComplete).toMatchObject({ status: "SOUMISE", budgetJustification: "Volume revu à 4 000 contrats" });
    expect(demandeComplete.requestedBudget?.toNumber()).toBe(80);
  });

  test("le formulaire de complément reprend le budget demandé et sa justification ; rien pour un autre utilisateur, même admin", async () => {
    const { id } = await createKeyRequest(deps, demandeur, { ...demande, requestedBudget: 50, budgetJustification: "Traitement de 2 000 contrats" });
    await requestCompletion(deps, admin, id, "Précisez le volume");
    expect(await completionDraft(deps, demandeur, id)).toEqual({ renewsRequestId: null, requestedBudget: 50, budgetJustification: "Traitement de 2 000 contrats" });
    expect(await completionDraft(deps, admin, id)).toBeNull();
  });

  test("une demande sans budget (canal de l'API) garde son comportement : ni budget, ni justification exigée", async () => {
    const { id } = await createKeyRequest(deps, demandeur, { ...demande, requestedBudget: null });
    expect(await testDb.accessRequest.findUniqueOrThrow({ where: { id } })).toMatchObject({ requestedBudget: null, budgetJustification: null });
  });

  test("le courriel de nouvelle demande récapitule le budget souhaité et sa justification", async () => {
    const mailer = new FakeMailer();
    await createKeyRequest({ ...deps, mailer, adminEmails: ["jdupont@linagora.com"] }, demandeur, { ...demande, requestedBudget: 50, budgetJustification: "Traitement de 2 000 contrats" });
    const [courriel] = mailer.outbox;
    expect(courriel.text).toContain("- Budget souhaité : 50 €\n- Justification du budget : Traitement de 2 000 contrats");
    expect(courriel.text).toContain("- Requested budget: €50\n- Budget justification: Traitement de 2 000 contrats");
  });
});
