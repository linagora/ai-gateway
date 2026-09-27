import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import contrat from "../src/lib/integrations/openapi-v1.json";
import {
  appeler,
  basculerIntegration,
  cleDemo,
  DEMO,
  declarerIntegration,
  erreur,
  installerDemo,
  jetonDemo,
  reglerIntegration,
  signerJeton,
  utilisateurPasserelle,
} from "./api";
import { ADMIN, ajouterAEquipe, connecter, demandeApprouvee, enrichirModele, retirerCle } from "./outils";

/*
 * API d'intégration /api/v1 (spécification #71, ticket #75), appelée par HTTP au travers du Caddy de dev, qui transmet
 * au portail l'adresse de l'appelant comme en production : jeton signé par l'intégration, contrôles dans l'ordre du
 * contrat (intégration active, adresse, plafond, périmètre), provisionnement au premier accès, erreurs traduites.
 */
const suffixe = Date.now().toString(36);
const personne = (n: string) => ({ uid: `api-${n}-${suffixe}`, email: `api-${n}-${suffixe}@example.org`, name: `Personne ${n} ${suffixe}` });

test.beforeAll(async ({ browser }) => {
  installerDemo();
  const admin = await connecter(browser, ADMIN);
  await enrichirModele(await admin.newPage(), { nom: "dev-public", nomAffiche: "Modèle public", niveau: "N1" });
  await admin.close();
});

test("par l'intégration « demo », un collaborateur jamais connecté au portail obtient ses équipes ; il est alors connu de la passerelle", async ({ request }) => {
  const collaborateur = personne("premier-acces");
  expect(await utilisateurPasserelle(collaborateur.uid)).toBeNull();

  const reponse = await appeler(request, "/me/teams", { jeton: jetonDemo(collaborateur) });
  expect(reponse.status()).toBe(200);
  expect(reponse.headers()["cache-control"]).toBe("no-store");
  expect(await reponse.json()).toEqual({ teams: [] });
  expect(await utilisateurPasserelle(collaborateur.uid)).toMatchObject({ user_email: collaborateur.email });

  await ajouterAEquipe(collaborateur.uid, "R&D");
  expect(await (await appeler(request, "/me/teams", { jeton: jetonDemo(collaborateur) })).json()).toEqual({ teams: [{ teamId: expect.any(String), teamAlias: "R&D" }] });
});

test("un jeton refusé reçoit 401 jeton_invalide avec son motif, en français par défaut ou en anglais ; une route inconnue, 404", async ({ request }) => {
  const collaborateur = personne("jetons");
  const [entete, charge, signature] = jetonDemo(collaborateur).split(".");
  const base64url = (valeur: object) => Buffer.from(JSON.stringify(valeur)).toString("base64url");
  const revendications = JSON.parse(Buffer.from(charge, "base64url").toString("utf8")) as Record<string, unknown>;
  const expire = jetonDemo(collaborateur, new Date(Date.now() - 10 * 60_000));
  for (const [motif, jeton] of [
    ["absent", undefined],
    ["signature", `${entete}.${base64url({ ...revendications, sub: "mmaudet" })}.${signature}`],
    ["algorithme", `${base64url({ alg: "none", typ: "JWT", kid: DEMO.kid })}.${charge}.`],
    ["integration_inconnue", signerJeton({ ...revendications, iss: "inconnue" }, { cle: cleDemo(), kid: DEMO.kid })],
    ["destinataire", signerJeton({ ...revendications, aud: "autre-service" }, { cle: cleDemo(), kid: DEMO.kid })],
    ["expire", expire],
  ] as const) {
    expect(await erreur(await appeler(request, "/me/teams", { jeton })), motif).toMatchObject({ statut: 401, code: "jeton_invalide", details: { reason: motif } });
  }
  expect((await erreur(await appeler(request, "/me/teams", { jeton: expire }))).message).toBe("Jeton d'intégration expiré.");
  expect((await erreur(await appeler(request, "/me/teams", { jeton: expire, langue: "en" }))).message).toBe("Integration token expired.");
  // Une route inconnue exige elle aussi le jeton ; une méthode non prévue n'est pas mise en cache non plus.
  expect(await erreur(await appeler(request, "/inconnue"))).toMatchObject({ statut: 401, code: "jeton_invalide" });
  expect(await erreur(await appeler(request, "/inconnue", { jeton: jetonDemo(collaborateur) }))).toMatchObject({ statut: 404, code: "introuvable", details: { objet: "route" } });
  const methode = await appeler(request, "/me/teams", { jeton: jetonDemo(collaborateur), methode: "DELETE" });
  expect([methode.status(), methode.headers()["cache-control"]]).toEqual([405, "no-store"]);
});

test("un uid inconnu dont l'adresse appartient déjà à un autre collaborateur est refusé (409), sans être provisionné", async ({ request }) => {
  const collaborateur = personne("identite");
  expect((await appeler(request, "/me/teams", { jeton: jetonDemo(collaborateur) })).status()).toBe(200);
  // Même personne, uid mal formé par l'intégration : aucun second collaborateur n'est créé.
  const erreurDeFormat = { ...collaborateur, uid: collaborateur.uid.toUpperCase() };
  expect(await erreur(await appeler(request, "/me/teams", { jeton: jetonDemo(erreurDeFormat) }))).toMatchObject({ statut: 409, code: "identite_incoherente", details: {} });
  expect(await utilisateurPasserelle(erreurDeFormat.uid)).toBeNull();
  // Une autre personne, inconnue elle aussi, mais d'adresse inconnue : provisionnée.
  const nouvelle = personne("identite-nouvelle");
  expect((await appeler(request, "/me/teams", { jeton: jetonDemo(nouvelle) })).status()).toBe(200);
  expect(await utilisateurPasserelle(nouvelle.uid)).toMatchObject({ user_email: nouvelle.email });
});

test("le contrat OpenAPI est servi à une intégration authentifiée", async ({ request }) => {
  const reponse = await appeler(request, "/openapi.json", { jeton: jetonDemo(personne("contrat")) });
  expect(reponse.status()).toBe(200);
  expect(await reponse.json()).toEqual(contrat);
  expect((await erreur(await appeler(request, "/openapi.json"))).statut).toBe(401);
});

test("une intégration déclarée dans l'onglet : désactivée 503, adresse hors liste 403 même falsifiée, hors périmètre 403, plafond 429 ; sa désactivation coupe l'API", async ({ browser, request }) => {
  const admin = await (await connecter(browser, ADMIN)).newPage();
  const integration = await declarerIntegration(admin, { id: `e2e-api-${suffixe}`, nom: `API ${suffixe}`, perimetres: ["Demandes"], adresses: ["203.0.113.10"], plafond: 3 });
  const collaborateur = personne("controles");
  const appel = (entetes: Record<string, string> = {}) => appeler(request, "/me/teams", { jeton: integration.jeton(collaborateur), entetes });

  // Désactivée à sa déclaration.
  expect(await erreur(await appel())).toMatchObject({ statut: 503, code: "integration_inactive", message: "Cette intégration est désactivée : ses appels sont refusés." });

  // Activée, mais appelée d'une autre adresse que la sienne : Caddy écrase l'adresse que prétend l'appelant.
  await basculerIntegration(admin, integration, "Activer");
  expect(await erreur(await appel())).toMatchObject({ statut: 403, code: "adresse_non_autorisee" });
  expect(await erreur(await appel({ "X-Real-IP": "203.0.113.10", "X-Forwarded-For": "203.0.113.10" }))).toMatchObject({ statut: 403, code: "adresse_non_autorisee" });

  // Depuis ses adresses, sans le périmètre « lecture » : hors périmètre (premier appel compté par le plafond).
  await reglerIntegration(admin, integration, { adresses: ["127.0.0.1", "::1", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"] });
  expect(await erreur(await appel())).toMatchObject({ statut: 403, code: "hors_perimetre", details: { scope: "lecture" } });

  // Avec la lecture : deux appels passent, le quatrième de la minute dépasse le plafond de trois.
  await reglerIntegration(admin, integration, { perimetres: ["Lecture", "Demandes"] });
  expect((await appel()).status()).toBe(200);
  expect((await appel()).status()).toBe(200);
  const plafond = await appel();
  expect(await erreur(plafond)).toMatchObject({ statut: 429, code: "trop_de_requetes" });
  expect(Number(plafond.headers()["retry-after"])).toBeGreaterThanOrEqual(1);

  // Désactivée : coupée aussitôt.
  await basculerIntegration(admin, integration, "Désactiver");
  expect(await erreur(await appel())).toMatchObject({ statut: 503, code: "integration_inactive" });
});

test("les lectures rendent au collaborateur, et à lui seul, ce que lui montre le portail : équipes, catalogue, demandes, clés", async ({ browser, request }) => {
  const collaborateur = personne("lectures");
  const page = await (await connecter(browser, collaborateur)).newPage();
  const lire = async (chemin: string, langue?: string) => {
    const reponse = await appeler(request, chemin, { jeton: jetonDemo(collaborateur), langue });
    expect(reponse.status(), chemin).toBe(200);
    expect(reponse.headers()["cache-control"]).toBe("no-store");
    return reponse.json();
  };

  // Catalogue : l'engagement est celui du formulaire de demande, mot pour mot, en français et en anglais.
  await ajouterAEquipe(collaborateur.uid, "R&D");
  await page.goto("/demandes/nouvelle");
  // Texte de la case à cocher, sans l'étoile des champs obligatoires ni les espaces insécables de la typographie française.
  const texte = (valeur: string) => valeur.replace(/\*$/, "").replace(/\s+/g, " ").trim();
  const engagement = texte(await page.locator("label", { has: page.locator('input[name="commitment"]') }).innerText());
  const catalogue = await lire("/catalog");
  expect(texte(catalogue.commitment)).toBe(engagement);
  const anglais = JSON.parse(readFileSync("messages/en.json", "utf8")) as { nouvelleDemande: { engagement: string } };
  expect((await lire("/catalog", "en")).commitment).toBe(anglais.nouvelleDemande.engagement);
  expect(catalogue.levels.find((n: { id: string }) => n.id === "N1")).toMatchObject({ name: "N1 Public", classifications: ["NC", "C1"], models: expect.arrayContaining(["dev-public"]) });
  expect(catalogue.models).toContainEqual(expect.objectContaining({ modelName: "dev-public", displayName: "Modèle public", dataLevel: "N1" }));

  // Équipes : R&D, dont il est membre, n'est pas à rejoindre ; LPS Paris l'est.
  expect((await lire("/me/teams")).teams.map((e: { teamAlias: string }) => e.teamAlias)).toEqual(["R&D"]);
  const aRejoindre = (await lire("/teams/joinable")).teams.map((e: { teamAlias: string }) => e.teamAlias);
  expect(aRejoindre).toContain("LPS Paris");
  expect(aRejoindre).not.toContain("R&D");

  // Demande approuvée dans le portail : l'API la montre avec le statut que lit le collaborateur dans « Mes demandes ».
  await demandeApprouvee(browser, page, collaborateur, "Lectures par l'API");
  await page.goto("/demandes");
  await expect(page.getByRole("row", { name: /Clé d'API.*R&D.*Approuvée/ })).toBeVisible();
  const [demande] = (await lire("/requests")).requests;
  expect(demande).toMatchObject({ kind: "KEY", teamAlias: "R&D", dataLevel: "N1", models: ["dev-public"], status: "APPROVED", statusLabel: "Approuvée" });
  expect((await lire("/requests", "en")).requests[0].statusLabel).toBe("Approved");
  expect((await lire("/keys")).toPickUp).toEqual([
    expect.objectContaining({ requestId: demande.id, teamAlias: "R&D", dataLevel: "N1", models: ["dev-public"], project: "Lectures par l'API", pickupDeadline: expect.any(String) }),
  ]);

  // Clé retirée dans le portail : l'API la montre émise, avec sa dépense et son budget, jamais sa valeur.
  const cle = await retirerCle(page);
  const cles = await lire("/keys");
  expect(cles.toPickUp).toEqual([]);
  expect(cles.keys).toEqual([
    expect.objectContaining({ requestId: demande.id, teamAlias: "R&D", status: "KEY_ISSUED", statusLabel: "Clé émise", gateway: expect.objectContaining({ spend: 0, maxBudget: 5, blocked: false }) }),
  ]);
  await page.goto("/cles");
  await expect(page.getByRole("main")).toContainText(cles.keys[0].alias);
  expect(JSON.stringify(cles)).not.toContain(cle);

  // Un autre collaborateur ne voit rien de tout cela.
  const autre = personne("lectures-autre");
  expect((await (await appeler(request, "/requests", { jeton: jetonDemo(autre) })).json()).requests).toEqual([]);
  expect(await (await appeler(request, "/keys", { jeton: jetonDemo(autre) })).json()).toEqual({ toPickUp: [], keys: [] });
});

