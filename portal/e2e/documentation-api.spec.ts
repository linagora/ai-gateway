import { expect, test } from "@playwright/test";
import { installerDemo, jetonDemo } from "./api";
import { connecter } from "./outils";

/*
 * Documentation de l'API d'intégration (spécification #71) : le contrat dans Swagger UI, hébergé par le portail, pour les
 * collaborateurs connectés, avec l'essai des routes par un jeton d'intégration.
 */
const suffixe = Date.now().toString(36);
const personne = (n: string) => ({ uid: `doc-api-${n}-${suffixe}`, email: `doc-api-${n}-${suffixe}@example.org`, name: `Personne ${n} ${suffixe}` });

test("un collaborateur connecté consulte le contrat dans Swagger UI, servi par le portail seul, et l'essaie avec un jeton d'intégration", async ({ browser }) => {
  installerDemo();
  const collaborateur = personne("lecteur");
  const page = await (await connecter(browser, collaborateur)).newPage();
  const externes: string[] = [];
  page.on("request", (requete) => {
    if (!requete.url().startsWith("http://localhost:3100/")) externes.push(requete.url());
  });
  await page.goto("/documentation/api");
  await expect(page.getByRole("heading", { level: 1, name: "API d'intégration" })).toBeVisible();
  const route = page.locator('.opblock-get:has([data-path="/me/teams"])');
  await expect(route).toBeVisible();

  // Essai : le jeton collé dans « Authorize » part avec l'appel, qui passe les contrôles de l'API. Le serveur de dev est
  // appelé sans le Caddy de dev, qui transmet l'adresse de l'appelant : l'API refuse donc l'adresse, après le jeton.
  await page.getByRole("button", { name: "Authorize" }).first().click();
  await page.getByRole("textbox", { name: "auth-bearer-value" }).fill(jetonDemo(collaborateur));
  await page.getByRole("button", { name: "Apply credentials" }).click();
  await page.getByRole("button", { name: "Close" }).click();
  await route.locator(".opblock-summary-control").click();
  await route.getByRole("button", { name: "Try it out" }).click();
  await route.getByRole("button", { name: "Execute" }).click();
  const reponse = route.locator(".live-responses-table tr.response");
  await expect(reponse.locator(".response-col_status")).toHaveText("403");
  await expect(reponse.locator(".response-col_description")).toContainText("adresse_non_autorisee");

  // Aucun script ni appel hors du portail : ni CDN, ni validateur en ligne.
  expect(externes).toEqual([]);
});

test("depuis le menu « API », un collaborateur apprend qu'il peut faire ses demandes par API, lit le guide d'intégration et revient au contrat", async ({ browser }) => {
  const page = await (await connecter(browser, personne("guide"))).newPage();
  await page.goto("/");
  await page.getByRole("navigation", { name: "Navigation principale" }).getByRole("link", { name: "API", exact: true }).click();
  await expect(page).toHaveURL(/\/documentation\/api$/);
  await expect(page.getByText(/^Le portail permet aussi de faire ses demandes par API/)).toBeVisible();
  await page.getByRole("link", { name: "guide d'intégration" }).click();
  await expect(page).toHaveURL(/\/documentation\/api\/guide$/);
  await expect(page.getByRole("heading", { level: 1, name: "Kit d'intégration du portail AI Gateway" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "6. Erreurs et limites" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "identite_incoherente", exact: false }).first()).toBeVisible();
  await page.getByRole("link", { name: "Contrat de l'API (Swagger)" }).click();
  await expect(page.locator('[data-path="/key-requests"]').first()).toBeVisible();
});

test("en anglais, la page de l'API et le guide d'intégration sont traduits", async ({ browser }) => {
  const page = await (await connecter(browser, personne("anglais"), "en-US")).newPage();
  await page.goto("/");
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "API", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Integration API" })).toBeVisible();
  await expect(page.getByText(/^The portal also lets requests be made through an API/)).toBeVisible();
  await page.getByRole("link", { name: "integration guide" }).click();
  await expect(page).toHaveURL(/\/documentation\/api\/guide$/);
  await expect(page.getByRole("heading", { level: 1, name: "AI Gateway portal integration kit" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "6. Errors and limits" })).toBeVisible();
  await expect(page.getByRole("link", { name: "API contract (Swagger)" })).toBeVisible();
});

test("sans session, la documentation de l'API renvoie vers la connexion", async ({ page }) => {
  await page.goto("/documentation/api");
  await expect(page).toHaveURL(/\/connexion/);
});
