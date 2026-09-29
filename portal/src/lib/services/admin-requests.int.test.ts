import { beforeEach, describe, expect, test } from "vitest";
import { resetDb, testDb } from "@/test/db";
import { FakeLiteLLM } from "@/test/fake-litellm";
import { FakeMailer } from "@/test/fake-mailer";
import {
  approveKeyRequest,
  approveTeamJoinRequest,
  countAdminPending,
  getRequestReview,
  listPendingRequests,
  listProcessedRequests,
  refuseRequest,
  requestCompletion,
} from "./admin-requests";
import { listAudit } from "./audit";
import { saveCatalogEntry } from "./catalog";
import { cancelRequest, completeRequest, createKeyRequest, createTeamJoinRequest, type KeyRequestInput, listMyRequests } from "./requests";
import { saveSettings } from "./settings";

const admin = { uid: "jdupont", email: "jdupont@linagora.com", name: "Jeanne Dupont", isAdmin: true };
const demandeur = { uid: "mmaudet", email: "mmaudet@linagora.com", name: "Michel-Marie Maudet", isAdmin: false };
const collegue = { uid: "pmartin", email: "pmartin@linagora.com", name: "Paul Martin", isAdmin: false };

let litellm: FakeLiteLLM;
let deps: { db: typeof testDb; litellm: FakeLiteLLM };

beforeEach(async () => {
  await resetDb();
  litellm = new FakeLiteLLM()
    .withModel({ modelName: "mistral-small" })
    .withModel({ modelName: "qwen3.8" })
    .withTeam({ teamId: "equipe-rd", teamAlias: "R&D", models: ["mistral-small", "qwen3.8"], memberUids: ["mmaudet", "pmartin"] });
  deps = { db: testDb, litellm };
  const entry = { shortDescriptionFr: "…", longDescriptionFr: "…", useCases: [], recommendedFor: [], visible: true };
  await saveCatalogEntry(deps, admin, { ...entry, modelName: "mistral-small", displayNameFr: "Mistral Small", dataLevel: "N2" });
  await saveCatalogEntry(deps, admin, { ...entry, modelName: "qwen3.8", displayNameFr: "Qwen 3.8", dataLevel: "N3" });
});

const demande: KeyRequestInput = {
  teamId: "equipe-rd",
  dataLevel: "N2",
  models: ["mistral-small", "qwen3.8"],
  justification: "Assistant de rédaction",
  project: "compte-rendu",
  requestedBudget: 20,
  requestedDays: 90,
  commitment: true,
};

describe("file de validation (F-30)", () => {
  test("les demandes soumises sont présentées de la plus ancienne à la plus récente", async () => {
    const premiere = await createKeyRequest(deps, demandeur, demande);
    const seconde = await createKeyRequest(deps, collegue, { ...demande, project: "veille" });
    expect((await listPendingRequests(deps, admin)).aTraiter.map((r) => r.id)).toEqual([premiere.id, seconde.id]);
  });

  test("un salarié n'accède pas à la file de validation", async () => {
    await expect(listPendingRequests(deps, demandeur)).rejects.toMatchObject({ code: "interdit" });
    await expect(listProcessedRequests(deps, demandeur)).rejects.toMatchObject({ code: "interdit" });
    await expect(countAdminPending(deps, demandeur)).rejects.toMatchObject({ code: "interdit" });
  });

  test("la pastille du menu ne compte que les demandes à valider : une clé approuvée attend son titulaire, pas l'admin", async () => {
    await createKeyRequest(deps, demandeur, demande);
    const approuvee = await createKeyRequest(deps, collegue, { ...demande, project: "veille" });
    await approveKeyRequest(deps, admin, approuvee.id, parametres);
    const refusee = await createKeyRequest(deps, collegue, { ...demande, project: "essai" });
    await refuseRequest(deps, admin, refusee.id, "Hors périmètre");
    expect(await countAdminPending(deps, admin)).toBe(1);
  });

  test("l'archive donne les demandes déjà traitées, la plus récente d'abord, avec la décision", async () => {
    const enAttente = await createKeyRequest(deps, demandeur, demande);
    const refusee = await createKeyRequest(deps, collegue, { ...demande, project: "essai" });
    await refuseRequest(deps, admin, refusee.id, "Hors périmètre");
    const annulee = await createKeyRequest(deps, demandeur, { ...demande, project: "abandon" });
    await cancelRequest(deps, demandeur, annulee.id);
    const { elements: archive } = await listProcessedRequests(deps, admin);
    expect(archive.map((r) => [r.id, r.status])).toEqual([
      [annulee.id, "ANNULEE"],
      [refusee.id, "REFUSEE"],
    ]);
    expect(archive.find((r) => r.id === refusee.id)).toMatchObject({ decidedBy: "jdupont", decisionComment: "Hors périmètre", requesterUid: "pmartin" });
    expect(archive.map((r) => r.id)).not.toContain(enAttente.id);
  });

  test("l'archive se lit par pages de 50, la plus récente d'abord ; une page hors limites mène à la plus proche", async () => {
    expect(await listProcessedRequests(deps, admin)).toEqual({ elements: [], page: 1, pages: 1, total: 0 });
    const debut = Date.parse("2026-09-01T08:00:00Z");
    await testDb.accessRequest.createMany({
      data: Array.from({ length: 120 }, (_, i) => ({
        kind: "CLE" as const, status: "REFUSEE" as const, requesterUid: `salarie-${i}`, requesterEmail: `salarie-${i}@linagora.com`, teamId: "equipe-rd", teamAlias: "R&D",
        dataLevel: "N1" as const, models: ["mistral-small"], justification: "Essai", updatedAt: new Date(debut + i * 60_000),
      })),
    });
    const premiere = await listProcessedRequests(deps, admin);
    expect(premiere).toMatchObject({ page: 1, pages: 3, total: 120 });
    expect(premiere.elements).toHaveLength(50);
    expect(premiere.elements.slice(0, 2).map((r) => r.requesterUid)).toEqual(["salarie-119", "salarie-118"]);
    const derniere = await listProcessedRequests(deps, admin, 3);
    expect(derniere.elements.map((r) => r.requesterUid)).toEqual(Array.from({ length: 20 }, (_, i) => `salarie-${19 - i}`));
    expect(await listProcessedRequests(deps, admin, 99)).toMatchObject({ page: 3 });
    expect(await listProcessedRequests(deps, admin, 0)).toMatchObject({ page: 1 });
  });
});

describe("fiche de validation (F-32)", () => {
  test("les contrôles sont rejoués avec l'état actuel du catalogue", async () => {
    const { id } = await createKeyRequest(deps, demandeur, demande);
    const entry = { shortDescriptionFr: "…", longDescriptionFr: "…", useCases: [], recommendedFor: [] };
    await saveCatalogEntry(deps, admin, { ...entry, modelName: "qwen3.8", displayNameFr: "Qwen 3.8", dataLevel: "N3", visible: false });
    const review = await getRequestReview(deps, admin, id);
    expect(review.checks.filter((c) => !c.ok)).toEqual([{ id: "modeles_visibles", ok: false, offending: ["qwen3.8"] }]);
  });
});

const parametres = { models: ["mistral-small"], budget: 15, budgetDuration: "30d", days: 60, rpmLimit: null, tpmLimit: null };

describe("approbation (F-31)", () => {
  test("approuver fige les paramètres de la clé et passe la demande à APPROUVEE", async () => {
    const { id } = await createKeyRequest(deps, demandeur, demande);
    await approveKeyRequest(deps, admin, id, parametres);
    expect(await getRequestReview(deps, admin, id)).toMatchObject({
      status: "APPROUVEE",
      decidedBy: "jdupont",
      approved: { models: ["mistral-small"], budget: 15, budgetDuration: "30d", days: 60, rpmLimit: null, tpmLimit: null },
    });
  });

  test("règle 4 : les contrôles sont rejoués avec les modèles modifiés par l'admin", async () => {
    const { id } = await createKeyRequest(deps, demandeur, { ...demande, dataLevel: "N3", models: ["qwen3.8"] });
    await expect(approveKeyRequest(deps, admin, id, { ...parametres, models: ["qwen3.8", "mistral-small"] })).rejects.toMatchObject({
      code: "controles_en_echec",
      failedChecks: [{ id: "niveau_modeles", ok: false, offending: ["mistral-small"] }],
    });
  });

  test("règle 7 : sans réglage par défaut, un budget non saisi bloque l'approbation", async () => {
    const { id } = await createKeyRequest(deps, demandeur, demande);
    await expect(approveKeyRequest(deps, admin, id, { ...parametres, budget: null })).rejects.toMatchObject({ code: "parametre_manquant" });
  });

  test("règle 7 : les réglages par défaut (F-51) complètent les paramètres non saisis", async () => {
    await saveSettings(deps, admin, { default_budget: "25", default_budget_duration: "30d", default_days: "90" });
    const { id } = await createKeyRequest(deps, demandeur, demande);
    await approveKeyRequest(deps, admin, id, { ...parametres, budget: null, budgetDuration: null, days: null });
    expect((await getRequestReview(deps, admin, id)).approved).toMatchObject({ budget: 25, budgetDuration: "30d", days: 90 });
  });
});

describe("équipe choisie par l'admin à l'approbation d'une clé", () => {
  test("l'admin rattache la clé à une autre équipe : l'approbation y ajoute le demandeur", async () => {
    litellm.withTeam({ teamId: "equipe-lps", teamAlias: "LPS Paris", models: [], memberUids: [] });
    const { id } = await createKeyRequest(deps, demandeur, demande);
    await approveKeyRequest(deps, admin, id, { ...parametres, teamId: "equipe-lps" });
    expect(await getRequestReview(deps, admin, id)).toMatchObject({ status: "APPROUVEE", teamId: "equipe-lps", teamAlias: "LPS Paris" });
    expect((await litellm.getTeam("equipe-lps"))?.memberUids).toContain("mmaudet");
  });

  test("les contrôles sont rejoués pour l'équipe choisie, et un refus ne touche à aucune équipe", async () => {
    litellm.withTeam({ teamId: "equipe-restreinte", teamAlias: "Restreinte", models: ["qwen3.8"], memberUids: [] });
    const { id } = await createKeyRequest(deps, demandeur, demande);
    await expect(approveKeyRequest(deps, admin, id, { ...parametres, teamId: "equipe-restreinte" })).rejects.toMatchObject({
      code: "controles_en_echec",
      failedChecks: [{ id: "modeles_equipe", ok: false, offending: ["mistral-small"] }],
    });
    expect((await litellm.getTeam("equipe-restreinte"))?.memberUids).toEqual([]);
    expect(await getRequestReview(deps, admin, id)).toMatchObject({ status: "SOUMISE", teamAlias: "R&D" });
  });

  test("sans changement d'équipe, un demandeur qui n'en est plus membre bloque toujours l'approbation", async () => {
    const { id } = await createKeyRequest(deps, demandeur, demande);
    litellm.withTeam({ teamId: "equipe-rd", teamAlias: "R&D", models: ["mistral-small", "qwen3.8"], memberUids: ["pmartin"] });
    await expect(approveKeyRequest(deps, admin, id, parametres)).rejects.toMatchObject({
      code: "controles_en_echec",
      failedChecks: [{ id: "membre_equipe", ok: false, offending: ["mmaudet"] }],
    });
  });

  test("une équipe inconnue est refusée", async () => {
    const { id } = await createKeyRequest(deps, demandeur, demande);
    await expect(approveKeyRequest(deps, admin, id, { ...parametres, teamId: "equipe-inconnue" })).rejects.toMatchObject({ code: "introuvable" });
  });
});

describe("refus (F-31)", () => {
  test("refuser sans motif est impossible", async () => {
    const { id } = await createKeyRequest(deps, demandeur, demande);
    await expect(refuseRequest(deps, admin, id, " ")).rejects.toMatchObject({ code: "motif_obligatoire" });
  });

  test("le demandeur voit le refus et son motif dans Mes demandes", async () => {
    const { id } = await createKeyRequest(deps, demandeur, demande);
    await refuseRequest(deps, admin, id, "Utilisez l'équipe du projet");
    expect(await listMyRequests(deps, demandeur)).toMatchObject([{ id, status: "REFUSEE", decisionComment: "Utilisez l'équipe du projet" }]);
  });

  test("une demande déjà approuvée ne peut plus être refusée", async () => {
    const { id } = await createKeyRequest(deps, demandeur, demande);
    await approveKeyRequest(deps, admin, id, parametres);
    await expect(refuseRequest(deps, admin, id, "Trop tard")).rejects.toMatchObject({ code: "transition_interdite" });
  });
});

describe("demande de complément (F-31, F-24)", () => {
  test("la demande revient au demandeur avec le commentaire de l'admin", async () => {
    const { id } = await createKeyRequest(deps, demandeur, demande);
    await requestCompletion(deps, admin, id, "Précisez le projet");
    expect(await listMyRequests(deps, demandeur)).toMatchObject([{ id, status: "A_COMPLETER", decisionComment: "Précisez le projet" }]);
  });

  test("la demande complétée repasse en SOUMISE avec les nouvelles informations", async () => {
    const { id } = await createKeyRequest(deps, demandeur, demande);
    await requestCompletion(deps, admin, id, "Précisez le projet");
    await completeRequest(deps, demandeur, id, { ...demande, project: "comptes-rendus-codir" });
    expect(await getRequestReview(deps, admin, id)).toMatchObject({ status: "SOUMISE", project: "comptes-rendus-codir" });
  });
});

describe("demande d'accès à une équipe (F-22)", () => {
  test("approuver une demande d'accès ajoute le demandeur à l'équipe dans LiteLLM", async () => {
    litellm.withTeam({ teamId: "equipe-data", teamAlias: "Data", models: ["mistral-small"], memberUids: ["jdupont"] });
    const { id } = await createTeamJoinRequest(deps, demandeur, { teamId: "equipe-data", justification: "Projet d'analyse" });
    await approveTeamJoinRequest(deps, admin, id);
    expect((await litellm.getTeam("equipe-data"))?.memberUids).toContain("mmaudet");
  });

  test("l'admin peut affecter le demandeur à une autre équipe que celle demandée", async () => {
    litellm.withTeam({ teamId: "equipe-data", teamAlias: "Data", models: [], memberUids: [] });
    litellm.withTeam({ teamId: "equipe-lps", teamAlias: "LPS Paris", models: [], memberUids: [] });
    const { id } = await createTeamJoinRequest(deps, demandeur, { teamId: "equipe-data", justification: "Projet d'analyse" });
    await approveTeamJoinRequest(deps, admin, id, "equipe-lps");
    expect((await litellm.getTeam("equipe-lps"))?.memberUids).toContain("mmaudet");
    expect((await litellm.getTeam("equipe-data"))?.memberUids).not.toContain("mmaudet");
    expect((await listMyRequests(deps, demandeur)).find((r) => r.id === id)).toMatchObject({ teamAlias: "LPS Paris", status: "APPROUVEE" });
  });

  test("approuver la demande d'un salarié déjà membre de l'équipe l'approuve, sans nouvel ajout dans LiteLLM", async () => {
    litellm.withTeam({ teamId: "equipe-data", teamAlias: "Data", models: [], memberUids: [] });
    const { id } = await createTeamJoinRequest(deps, demandeur, { teamId: "equipe-data", justification: "Projet d'analyse" });
    // Ajouté entre-temps, par une autre demande ou depuis la console de LiteLLM.
    await litellm.addTeamMember("equipe-data", "mmaudet");
    await approveTeamJoinRequest(deps, admin, id);
    expect((await listMyRequests(deps, demandeur)).find((r) => r.id === id)).toMatchObject({ status: "APPROUVEE" });
    expect((await litellm.getTeam("equipe-data"))?.memberUids.filter((uid) => uid === "mmaudet")).toHaveLength(1);
  });

  test("si la passerelle échoue à l'ajout, l'admin voit une indisponibilité et la demande reste à traiter", async () => {
    litellm.withTeam({ teamId: "equipe-data", teamAlias: "Data", models: [], memberUids: [] });
    const { id } = await createTeamJoinRequest(deps, demandeur, { teamId: "equipe-data", justification: "Projet d'analyse" });
    litellm.panne = true;
    await expect(approveTeamJoinRequest(deps, admin, id)).rejects.toMatchObject({ code: "passerelle_indisponible" });
    litellm.panne = false;
    expect((await listMyRequests(deps, demandeur)).find((r) => r.id === id)).toMatchObject({ status: "SOUMISE" });
  });

  test("une équipe d'affectation inconnue est refusée, et la demande reste à traiter", async () => {
    litellm.withTeam({ teamId: "equipe-data", teamAlias: "Data", models: [], memberUids: [] });
    const { id } = await createTeamJoinRequest(deps, demandeur, { teamId: "equipe-data", justification: "Projet d'analyse" });
    await expect(approveTeamJoinRequest(deps, admin, id, "equipe-inconnue")).rejects.toMatchObject({ code: "introuvable" });
    expect((await listMyRequests(deps, demandeur)).find((r) => r.id === id)).toMatchObject({ teamAlias: "Data", status: "SOUMISE" });
  });
});

describe("journal d'audit des décisions (ticket #22)", () => {
  const journal = async () => (await listAudit(testDb)).map((e) => [e.actorUid, e.action, e.details]);

  test("dépôt et approbation d'une demande de clé, avec l'équipe retenue", async () => {
    litellm.withTeam({ teamId: "equipe-lps", teamAlias: "LPS Paris", models: [], memberUids: [] });
    const { id } = await createKeyRequest(deps, demandeur, demande);
    await approveKeyRequest(deps, admin, id, { ...parametres, teamId: "equipe-lps" });
    expect(await journal()).toEqual([
      ["mmaudet", "REQUEST_CREATED", { kind: "CLE", teamAlias: "R&D" }],
      ["jdupont", "REQUEST_APPROVED", { teamAlias: "LPS Paris" }],
    ]);
    expect((await listAudit(testDb)).every((e) => e.targetId === id)).toBe(true);
  });

  test("refus avec le motif, et complément demandé avec le commentaire", async () => {
    const { id: refusee } = await createKeyRequest(deps, demandeur, demande);
    await refuseRequest(deps, admin, refusee, "Budget non justifié");
    const { id: aCompleter } = await createKeyRequest(deps, collegue, demande);
    await requestCompletion(deps, admin, aCompleter, "Précisez le projet");
    expect(await journal()).toEqual([
      ["mmaudet", "REQUEST_CREATED", { kind: "CLE", teamAlias: "R&D" }],
      ["jdupont", "REQUEST_REFUSED", { motif: "Budget non justifié" }],
      ["pmartin", "REQUEST_CREATED", { kind: "CLE", teamAlias: "R&D" }],
      ["jdupont", "COMPLETION_REQUESTED", { commentaire: "Précisez le projet" }],
    ]);
  });

  test("dépôt d'une demande d'accès et demande acceptée, avec l'équipe retenue", async () => {
    litellm.withTeam({ teamId: "equipe-data", teamAlias: "Data", models: [], memberUids: [] });
    litellm.withTeam({ teamId: "equipe-lps", teamAlias: "LPS Paris", models: [], memberUids: [] });
    const { id } = await createTeamJoinRequest(deps, demandeur, { teamId: "equipe-data", justification: "Projet d'analyse" });
    await approveTeamJoinRequest(deps, admin, id, "equipe-lps");
    expect(await journal()).toEqual([
      ["mmaudet", "REQUEST_CREATED", { kind: "ADHESION_EQUIPE", teamAlias: "Data" }],
      ["jdupont", "MEMBERSHIP_APPROVED", { teamAlias: "LPS Paris" }],
    ]);
  });
});

describe("courriels des décisions au demandeur (ticket #24)", () => {
  let mailer: FakeMailer;
  const avecCourriel = () => ({ ...deps, mailer, adminEmails: [], portalUrl: "https://portail.test", now: () => new Date("2026-10-01T09:00:00Z") });
  const recus = () => mailer.outbox.map((c) => ({ to: c.to, subject: c.subject, text: c.text }));

  beforeEach(async () => {
    mailer = new FakeMailer();
    await saveSettings(deps, admin, { pickup_days: "14" });
  });

  test("approbation : le demandeur est salué, les paramètres de sa clé récapitulés, avec l'échéance de retrait, jamais de clé", async () => {
    const { id } = await createKeyRequest(deps, demandeur, demande);
    await approveKeyRequest(avecCourriel(), admin, id, parametres);
    expect(recus()).toEqual([
      { to: ["mmaudet@linagora.com"], subject: "[AI GATEWAY] Votre demande de clé est approuvée / Your key request is approved", text: expect.stringContaining("Bonjour Michel-Marie Maudet,") },
    ]);
    const texte = recus()[0].text;
    expect(texte).toContain(
      [
        "Votre demande de clé d'API pour l'équipe R&D est approuvée. Paramètres de votre clé :",
        "- Équipe : R&D",
        "- Niveau de confidentialité : N2 Interne",
        "- Modèles accordés : mistral-small",
      ].join("\n"),
    );
    expect(texte).toMatch(/- Budget : 15,00\s€ par période de 30 jours\n- Durée de validité : 60 jours\n- Projet : compte-rendu/);
    expect(texte).toContain("Retirez votre clé avant le 15 octobre 2026 dans « Mes clés » : elle ne s'affichera qu'une seule fois.");
    expect(texte).toContain("Hello Michel-Marie Maudet,");
    expect(texte).toContain("Pick up your key before October 15, 2026 in “My keys”: it will be shown only once.");
    expect(texte).toContain("https://portail.test/cles");
  });

  test("refus, avec le motif", async () => {
    const { id } = await createKeyRequest(deps, demandeur, demande);
    await refuseRequest(avecCourriel(), admin, id, "Budget non justifié");
    expect(recus()).toEqual([
      { to: ["mmaudet@linagora.com"], subject: "[AI GATEWAY] Votre demande est refusée / Your request is refused", text: expect.stringContaining("Motif du refus : Budget non justifié") },
    ]);
    expect(recus()[0].text).toContain("Bonjour Michel-Marie Maudet,\n\nVotre demande de clé d'API pour l'équipe R&D est refusée.");
    expect(recus()[0].text).toContain("- Modèles : mistral-small, qwen3.8");
    expect(recus()[0].text).toContain("Reason for refusal: Budget non justifié");
  });

  test("complément demandé, avec le commentaire de l'admin et un lien vers « Mes demandes »", async () => {
    const { id } = await createKeyRequest(deps, demandeur, demande);
    await requestCompletion(avecCourriel(), admin, id, "Précisez le projet");
    expect(recus()).toEqual([
      {
        to: ["mmaudet@linagora.com"],
        subject: "[AI GATEWAY] Votre demande est à compléter / Your request needs more information",
        text: expect.stringContaining("Commentaire de l'administrateur : Précisez le projet"),
      },
    ]);
    expect(recus()[0].text).toContain("https://portail.test/demandes");
  });

  test("demande d'accès acceptée, avec l'équipe retenue", async () => {
    litellm.withTeam({ teamId: "equipe-data", teamAlias: "Data", models: [], memberUids: [] });
    litellm.withTeam({ teamId: "equipe-lps", teamAlias: "LPS Paris", models: [], memberUids: [] });
    const { id } = await createTeamJoinRequest(deps, demandeur, { teamId: "equipe-data", justification: "Projet d'analyse" });
    await approveTeamJoinRequest(avecCourriel(), admin, id, "equipe-lps");
    expect(recus()).toEqual([
      {
        to: ["mmaudet@linagora.com"],
        subject: "[AI GATEWAY] Votre demande d'accès est acceptée / Your access request is accepted",
        text: expect.stringContaining("Bonjour Michel-Marie Maudet,\n\nVotre demande d'accès est acceptée : vous êtes désormais membre de l'équipe LPS Paris."),
      },
    ]);
    expect(recus()[0].text).toContain("Your access request is accepted: you are now a member of the LPS Paris team.");
  });
});
