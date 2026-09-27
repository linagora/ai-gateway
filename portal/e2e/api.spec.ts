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
import { ADMIN, ajouterAEquipe, connecter } from "./outils";

/*
 * API d'intégration /api/v1 (spécification #71, ticket #75), appelée par HTTP au travers du Caddy de dev, qui transmet
 * au portail l'adresse de l'appelant comme en production : jeton signé par l'intégration, contrôles dans l'ordre du
 * contrat (intégration active, adresse, plafond, périmètre), provisionnement au premier accès, erreurs traduites.
 */
const suffixe = Date.now().toString(36);
const personne = (n: string) => ({ uid: `api-${n}-${suffixe}`, email: `api-${n}-${suffixe}@example.org`, name: `Personne ${n} ${suffixe}` });

test.beforeAll(() => installerDemo());

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
  expect(await erreur(await appeler(request, "/inconnue", { jeton: jetonDemo(collaborateur) }))).toMatchObject({ statut: 404, code: "introuvable", details: { objet: "route" } });
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
