import { expect, test } from "@playwright/test";
import { appeler, basculerIntegration, declarerIntegration, erreur, installerDemo, jetonDemo } from "./api";
import { ADMIN, ajouterAEquipe, connecter, courriels, enrichirModele, type Personne } from "./outils";

/*
 * Demandes par l'API d'intégration (spécification #71, ticket #78) : les mêmes services que les pages du portail font
 * les contrôles, les courriels et la validation ; les demandes venues d'une intégration se valident dans le portail
 * comme les autres. Admins à notifier : admins-e2e@example.org (.env).
 */
const suffixe = Date.now().toString(36);
const personne = (n: string): Personne => ({ uid: `api-dem-${n}-${suffixe}`, email: `api-dem-${n}-${suffixe}@example.org`, name: `Personne ${n} ${suffixe}` });

test.beforeAll(async ({ browser }) => {
  installerDemo();
  const admin = await connecter(browser, ADMIN);
  await enrichirModele(await admin.newPage(), { nom: "dev-public", nomAffiche: "Modèle public", niveau: "N1" });
  await admin.close();
});

test("une demande de clé par l'API : refusée sans engagement ou hors politique, puis examinée dans le portail avec les mêmes courriels, complétée par l'API, approuvée et lue par l'API", async ({ browser, request }) => {
  const collaborateur = personne("cle");
  const jeton = () => jetonDemo(collaborateur);
  const lire = async (chemin: string) => (await appeler(request, chemin, { jeton: jeton() })).json();
  // Premier accès (provisionnement), puis entrée dans R&D.
  expect((await appeler(request, "/me/teams", { jeton: jeton() })).status()).toBe(200);
  await ajouterAEquipe(collaborateur.uid, "R&D");
  const [{ teamId }] = (await lire("/me/teams")).teams;
  const demande = { teamId, dataLevel: "N1", models: ["dev-public"], justification: "Assistant de rédaction", project: "Projet API", requestedDays: 30 };
  const deposer = (corps: object, langue?: string) => appeler(request, "/key-requests", { jeton: jeton(), methode: "POST", corps, langue });

  expect(await erreur(await deposer(demande))).toMatchObject({
    statut: 400,
    code: "engagement_requis",
    message: "Engagez-vous à ne pas soumettre de données d'un niveau supérieur à celui déclaré.",
  });
  const horsPolitique = await erreur(await deposer({ ...demande, dataLevel: "N3", commitment: true }, "en"));
  expect(horsPolitique).toMatchObject({ statut: 400, code: "controles_en_echec", details: { failedChecks: [{ id: "niveau_modeles", offending: ["dev-public"] }] } });
  expect(horsPolitique.message).toBe("The request does not comply with the model access policy. Failed checks: The models accept the declared confidentiality level (dev-public).");

  const creee = await deposer({ ...demande, commitment: true });
  expect(creee.status()).toBe(201);
  const { id } = (await creee.json()) as { id: string };
  expect((await lire("/requests")).requests).toEqual([expect.objectContaining({ id, kind: "KEY", status: "SUBMITTED", statusLabel: "Soumise" })]);
  await expect
    .poll(async () => (await courriels(collaborateur.uid)).find((c) => c.subject.includes(`Nouvelle demande de clé d'API de ${collaborateur.name}`))?.to, { timeout: 15_000 })
    .toEqual(["admins-e2e@example.org"]);

  // L'admin l'examine dans le portail et demande un complément ; le collaborateur le lit et complète par l'API.
  const admin = await (await connecter(browser, ADMIN)).newPage();
  const examiner = async () => {
    await admin.goto("/gestion/demandes");
    await admin.getByRole("row", { name: new RegExp(`${collaborateur.uid}.*Clé d'API`) }).getByRole("link", { name: "Examiner" }).click();
  };
  await examiner();
  await admin.getByLabel("Complément demandé").fill("Précisez le projet");
  await admin.getByRole("button", { name: "Demander un complément" }).click();
  await expect(admin.getByRole("status")).toHaveText("Demande renvoyée au demandeur pour complément.");
  expect((await lire("/requests")).requests[0]).toMatchObject({ status: "NEEDS_COMPLETION", statusLabel: "À compléter", decisionComment: "Précisez le projet" });
  const completer = (demandeId: string, corps: object) => appeler(request, `/key-requests/${demandeId}`, { jeton: jeton(), methode: "PUT", corps });
  expect((await completer(id, { ...demande, project: "Compte-rendu hebdomadaire", commitment: true })).status()).toBe(204);
  expect((await lire("/requests")).requests[0]).toMatchObject({ status: "SUBMITTED" });

  // Approuvée dans le portail : le statut se lit par l'API ; elle ne s'annule plus (409).
  await examiner();
  await admin.getByLabel("Budget (€)").fill("5");
  await admin.getByLabel("Période du budget (ex. 30d)").fill("30d");
  await admin.getByLabel("Durée de validité").selectOption({ label: "1 mois" });
  await admin.getByRole("button", { name: "Approuver", exact: true }).click();
  await expect(admin.getByRole("status")).toHaveText("Demande approuvée.");
  expect((await lire("/requests")).requests[0]).toMatchObject({ status: "APPROVED", statusLabel: "Approuvée" });
  expect(await erreur(await appeler(request, `/requests/${id}/cancel`, { jeton: jeton(), methode: "POST" }))).toMatchObject({ statut: 409, code: "transition_interdite" });

  // Un autre collaborateur ne trouve pas cette demande.
  const autre = personne("autre");
  expect(await erreur(await appeler(request, `/requests/${id}/cancel`, { jeton: jetonDemo(autre), methode: "POST" }))).toMatchObject({ statut: 404, code: "introuvable" });
  expect(await erreur(await appeler(request, `/key-requests/${id}`, { jeton: jetonDemo(autre), methode: "PUT", corps: { ...demande, commitment: true } }))).toMatchObject({
    statut: 404,
    code: "introuvable",
  });
});

test("une demande d'accès à une équipe par l'API part en validation, s'annule une fois, et ne se redépose pas en double", async ({ request }) => {
  const collaborateur = personne("acces");
  const jeton = () => jetonDemo(collaborateur);
  const equipes = (await (await appeler(request, "/teams/joinable", { jeton: jeton() })).json()).teams as { teamId: string; teamAlias: string }[];
  const lps = equipes.find((e) => e.teamAlias === "LPS Paris");
  expect(lps).toBeDefined();
  const deposer = () => appeler(request, "/team-access-requests", { jeton: jeton(), methode: "POST", corps: { teamId: lps?.teamId, justification: "Rejoindre LPS Paris" } });

  const creee = await deposer();
  expect(creee.status()).toBe(201);
  const { id } = (await creee.json()) as { id: string };
  expect(await erreur(await deposer())).toMatchObject({ statut: 409, code: "demande_en_cours" });
  await expect
    .poll(async () => (await courriels(collaborateur.uid)).some((c) => c.subject.includes(`Nouvelle demande d'accès à une équipe de ${collaborateur.name}`)), { timeout: 15_000 })
    .toBe(true);

  const annuler = () => appeler(request, `/requests/${id}/cancel`, { jeton: jeton(), methode: "POST" });
  expect((await annuler()).status()).toBe(204);
  expect((await (await appeler(request, "/requests", { jeton: jeton() })).json()).requests[0]).toMatchObject({ id, kind: "TEAM_ACCESS", status: "CANCELLED", statusLabel: "Annulée" });
  expect(await erreur(await annuler())).toMatchObject({ statut: 409, code: "transition_interdite" });
  // Une saisie mal formée est refusée avant tout service ; un identifiant mal formé est introuvable.
  expect(await erreur(await appeler(request, "/team-access-requests", { jeton: jeton(), methode: "POST", corps: { teamId: lps?.teamId, motif: "?" } }))).toMatchObject({
    statut: 400,
    code: "saisie_invalide",
    details: { fields: ["justification", "motif"] },
  });
  expect(await erreur(await appeler(request, "/requests/PAS-UN-ID/cancel", { jeton: jeton(), methode: "POST" }))).toMatchObject({ statut: 404, code: "introuvable" });
});

test("une intégration sans le périmètre « demandes » ne dépose aucune demande (403)", async ({ browser, request }) => {
  const admin = await (await connecter(browser, ADMIN)).newPage();
  const integration = await declarerIntegration(admin, {
    id: `e2e-lecture-${suffixe}`,
    nom: `Lecture ${suffixe}`,
    perimetres: ["Lecture"],
    adresses: ["127.0.0.1", "::1", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"],
    plafond: 120,
  });
  await basculerIntegration(admin, integration, "Activer");
  const collaborateur = personne("lecture-seule");
  expect((await appeler(request, "/me/teams", { jeton: integration.jeton(collaborateur) })).status()).toBe(200);
  expect(await erreur(await appeler(request, "/team-access-requests", { jeton: integration.jeton(collaborateur), methode: "POST", corps: { teamId: "x", justification: "y" } }))).toMatchObject({
    statut: 403,
    code: "hors_perimetre",
    details: { scope: "demandes" },
  });
  await basculerIntegration(admin, integration, "Désactiver");
});
