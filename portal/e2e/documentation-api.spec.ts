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
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("API d'intégration");
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

test("sans session, la documentation de l'API renvoie vers la connexion", async ({ page }) => {
  await page.goto("/documentation/api");
  await expect(page).toHaveURL(/\/connexion/);
});
