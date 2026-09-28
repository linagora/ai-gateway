import { type APIRequestContext, type Browser, expect, test } from "@playwright/test";
import { appeler, basculerIntegration, declarerIntegration, erreur, installerDemo, jetonDemo } from "./api";
import { ADMIN, appel, connecter, courriels, demandeApprouvee, enrichirModele, type Personne, retirerCle } from "./outils";

/*
 * Clés par l'API d'intégration (spécification #71, ticket #81) : retrait, remplacement et révocation de ses propres
 * clés, brouillon de renouvellement. Une clé n'est rendue qu'une fois, jamais mise en cache ; chaque retrait,
 * remplacement ou révocation par une intégration est annoncé au titulaire par un courriel qui la nomme.
 */
const suffixe = Date.now().toString(36);
const personne = (n: string): Personne => ({ uid: `api-cle-${n}-${suffixe}`, email: `api-cle-${n}-${suffixe}@example.org`, name: `Personne ${n} ${suffixe}` });

/** Nom de l'intégration « demo » dans le registre de dev (dev/integration-demo.mjs). */
const DEMO_NOM = "Démo (développement)";

test.beforeAll(async ({ browser }) => {
  installerDemo();
  const admin = await connecter(browser, ADMIN);
  await enrichirModele(await admin.newPage(), { nom: "dev-public", nomAffiche: "Modèle public", niveau: "N1" });
  await admin.close();
});

/** Le collaborateur, connecté une fois au portail, y obtient une demande de clé approuvée : son identifiant, lu par l'API. */
async function demandeDeCleApprouvee(browser: Browser, request: APIRequestContext, collaborateur: Personne): Promise<string> {
  const page = await (await connecter(browser, collaborateur)).newPage();
  await demandeApprouvee(browser, page, collaborateur, `Clés par l'API ${suffixe}`);
  await page.context().close();
  const { toPickUp } = (await (await appeler(request, "/keys", { jeton: jetonDemo(collaborateur) })).json()) as { toPickUp: { requestId: string }[] };
  return toPickUp[0].requestId;
}

/** Action de l'API sur une demande de clé ou sur une clé, pour le collaborateur. */
const agir = (request: APIRequestContext, collaborateur: Personne, chemin: string, methode: "GET" | "POST" = "POST") =>
  appeler(request, chemin, { jeton: jetonDemo(collaborateur), methode });

/** Nombre de clés du collaborateur dans la passerelle de dev, lu par l'API d'administration de LiteLLM. */
async function clesDansLaPasserelle(uid: string): Promise<number> {
  const reponse = await fetch(`http://127.0.0.1:54400/admin/user/info?user_id=${encodeURIComponent(uid)}`, { headers: { Authorization: "Bearer sk-dev-master-key" } });
  return ((await reponse.json()) as { keys: unknown[] }).keys.length;
}

/** Courriel reçu par le titulaire dont l'objet contient le texte, attendu jusqu'à 15 s : ses destinataires. */
const destinatairesDu = (collaborateur: Personne, objet: string) =>
  expect.poll(async () => (await courriels(collaborateur.uid)).find((c) => c.subject.includes(objet))?.to, { timeout: 15_000 });

test("un retrait par l'API rend la clé une seule fois, sans mise en cache : elle fonctionne auprès de la passerelle, et le titulaire reçoit un courriel qui nomme l'intégration", async ({ browser, request }) => {
  const collaborateur = personne("retrait");
  const id = await demandeDeCleApprouvee(browser, request, collaborateur);

  const retrait = await agir(request, collaborateur, `/key-requests/${id}/pickup`);
  expect(retrait.status()).toBe(201);
  expect(retrait.headers()["cache-control"]).toBe("no-store");
  const { key, alias } = (await retrait.json()) as { key: string; alias: string };
  expect(await appel(request, key)).toBe(200);
  expect(await erreur(await agir(request, collaborateur, `/key-requests/${id}/pickup`))).toMatchObject({ statut: 409, code: "transition_interdite" });
  await destinatairesDu(collaborateur, `${alias} a été retirée par ${DEMO_NOM}`).toEqual([collaborateur.email]);
});

test("deux retraits simultanés de la même demande n'émettent qu'une clé", async ({ browser, request }) => {
  const collaborateur = personne("simultanes");
  const id = await demandeDeCleApprouvee(browser, request, collaborateur);
  const statuts = await Promise.all([1, 2].map(async () => (await agir(request, collaborateur, `/key-requests/${id}/pickup`)).status()));
  expect(statuts.sort()).toEqual([201, 409]);
  expect(await clesDansLaPasserelle(collaborateur.uid)).toBe(1);
});

test("un remplacement par l'API émet une nouvelle clé aux mêmes paramètres et supprime l'ancienne, avec un courriel au titulaire", async ({ browser, request }) => {
  const collaborateur = personne("remplacement");
  const id = await demandeDeCleApprouvee(browser, request, collaborateur);
  const { key: ancienne, alias: ancienAlias } = (await (await agir(request, collaborateur, `/key-requests/${id}/pickup`)).json()) as { key: string; alias: string };
  const cleEmise = async () => ((await (await agir(request, collaborateur, "/keys", "GET")).json()) as { keys: Record<string, unknown>[] }).keys[0];
  const avant = await cleEmise();

  const remplacement = await agir(request, collaborateur, `/keys/${id}/replace`);
  expect(remplacement.status()).toBe(201);
  expect(remplacement.headers()["cache-control"]).toBe("no-store");
  const { key: nouvelle, alias } = (await remplacement.json()) as { key: string; alias: string };
  expect(alias).toBe(`${ancienAlias}-2`);
  expect(await cleEmise()).toMatchObject({ alias, teamId: avant.teamId, dataLevel: avant.dataLevel, models: avant.models, expiresAt: avant.expiresAt, status: "KEY_ISSUED" });
  expect(await appel(request, nouvelle)).toBe(200);
  await expect.poll(() => appel(request, ancienne), { timeout: 15_000, intervals: [1_000] }).toBe(401);
  await destinatairesDu(collaborateur, `${ancienAlias} a été remplacée par ${DEMO_NOM}`).toEqual([collaborateur.email]);
});

test("une révocation par l'API coupe la clé et l'annonce au titulaire ; la clé d'un autre collaborateur reste introuvable", async ({ browser, request }) => {
  const collaborateur = personne("revocation");
  const autre = personne("revocation-autre");
  const id = await demandeDeCleApprouvee(browser, request, collaborateur);
  const { key, alias } = (await (await agir(request, collaborateur, `/key-requests/${id}/pickup`)).json()) as { key: string; alias: string };

  for (const chemin of [`/key-requests/${id}/pickup`, `/keys/${id}/replace`, `/keys/${id}/revoke`]) {
    expect(await erreur(await agir(request, autre, chemin)), chemin).toMatchObject({ statut: 404, code: "introuvable" });
  }
  const revocation = await agir(request, collaborateur, `/keys/${id}/revoke`);
  expect(revocation.status()).toBe(204);
  expect(revocation.headers()["cache-control"]).toBe("no-store");
  await expect.poll(() => appel(request, key), { timeout: 15_000, intervals: [1_000] }).toBe(401);
  expect(((await (await agir(request, collaborateur, "/keys", "GET")).json()) as { keys: unknown[] }).keys[0]).toMatchObject({ alias, status: "REVOKED" });
  await destinatairesDu(collaborateur, `${alias} a été révoquée par ${DEMO_NOM}`).toEqual([collaborateur.email]);
});

test("le brouillon de renouvellement par l'API reprend les paramètres de sa propre clé et préremplit la demande de renouvellement", async ({ browser, request }) => {
  const collaborateur = personne("brouillon");
  const autre = personne("brouillon-autre");
  const id = await demandeDeCleApprouvee(browser, request, collaborateur);
  const { alias } = (await (await agir(request, collaborateur, `/key-requests/${id}/pickup`)).json()) as { alias: string };

  const reponse = await agir(request, collaborateur, `/keys/${id}/renewal-draft`, "GET");
  expect(reponse.status()).toBe(200);
  expect(reponse.headers()["cache-control"]).toBe("no-store");
  const brouillon = await reponse.json();
  expect(brouillon).toEqual({ alias, teamId: expect.any(String), dataLevel: "N1", models: ["dev-public"], project: `Clés par l'API ${suffixe}`, requestedDays: 30 });
  expect(await erreur(await agir(request, autre, `/keys/${id}/renewal-draft`, "GET"))).toMatchObject({ statut: 404, code: "introuvable" });

  const { teamId, dataLevel, models, project, requestedDays } = brouillon;
  const renouvellement = { teamId, dataLevel, models, project, requestedDays, justification: "Renouvellement", commitment: true, renewsRequestId: id };
  expect((await appeler(request, "/key-requests", { jeton: jetonDemo(collaborateur), methode: "POST", corps: renouvellement })).status()).toBe(201);
});

test("une intégration sans le périmètre « cles » ne retire, ne remplace, ne révoque ni ne prépare aucune clé (403)", async ({ browser, request }) => {
  const admin = await (await connecter(browser, ADMIN)).newPage();
  const integration = await declarerIntegration(admin, {
    id: `e2e-sans-cles-${suffixe}`,
    nom: `Sans clés ${suffixe}`,
    perimetres: ["Lecture", "Demandes"],
    adresses: ["127.0.0.1", "::1", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"],
    plafond: 120,
  });
  await basculerIntegration(admin, integration, "Activer");
  const collaborateur = personne("sans-cles");
  const routes = [["/key-requests/x1/pickup", "POST"], ["/keys/x1/replace", "POST"], ["/keys/x1/revoke", "POST"], ["/keys/x1/renewal-draft", "GET"]] as const;
  for (const [chemin, methode] of routes) {
    expect(await erreur(await appeler(request, chemin, { jeton: integration.jeton(collaborateur), methode })), chemin).toMatchObject({
      statut: 403,
      code: "hors_perimetre",
      details: { scope: "cles" },
    });
  }
  await basculerIntegration(admin, integration, "Désactiver");
});

test("au-delà de cinq retraits ou remplacements en dix minutes, dans le portail et par l'API confondus, l'API répond 429 avec le délai avant de réessayer", async ({ browser, request }) => {
  const collaborateur = personne("limite");
  const page = await (await connecter(browser, collaborateur)).newPage();
  await demandeApprouvee(browser, page, collaborateur, `Clés par l'API ${suffixe}`);
  // Le retrait se fait dans le portail, puis les remplacements par l'API : ils comptent ensemble.
  await retirerCle(page);
  const { keys } = (await (await agir(request, collaborateur, "/keys", "GET")).json()) as { keys: { requestId: string }[] };
  const id = keys[0].requestId;
  for (let i = 0; i < 4; i++) expect((await agir(request, collaborateur, `/keys/${id}/replace`)).status()).toBe(201);
  const refus = await agir(request, collaborateur, `/keys/${id}/replace`);
  expect(await erreur(refus)).toMatchObject({ statut: 429, code: "trop_de_generations" });
  expect(Number(refus.headers()["retry-after"])).toBeGreaterThan(0);
});
