import { expect, test } from "@playwright/test";
import { ADMIN, connecter, enrichirModele } from "./outils";

/* Onglet « Supervision » : l'état de chaque modèle visible du catalogue, tenu par la sonde régulière. */
const suffixe = Date.now().toString(36);

test.beforeAll(async ({ browser }) => {
  const context = await connecter(browser, ADMIN);
  const page = await context.newPage();
  await enrichirModele(page, { nom: "dev-public", nomAffiche: "Modèle public", niveau: "N1" });
  await enrichirModele(page, { nom: "dev-image", nomAffiche: "Modèle d'images", niveau: "N1" });
  await context.close();
});

test("un admin sonde les modèles visibles depuis l'onglet « Supervision » ; un modèle d'images n'est pas sondé", async ({ browser }) => {
  const page = await (await connecter(browser, ADMIN)).newPage();
  await page.goto("/gestion/demandes");
  await page.getByRole("navigation", { name: "Administration" }).getByRole("link", { name: "Supervision" }).click();
  await expect(page.getByRole("heading", { name: "Supervision des modèles" })).toBeVisible();

  await page.getByRole("button", { name: "Sonder maintenant" }).click();
  // Une sonde attend jusqu'à 30 s un modèle qui ne répond pas.
  await expect(page.getByText("Sonde terminée.")).toBeVisible({ timeout: 45_000 });
  await expect(page.getByRole("row", { name: /Modèle public.*dev-public.*Répond/ })).toBeVisible();
  await expect(page.getByRole("row", { name: /Modèle d'images.*dev-image.*Non sondé/ })).toBeVisible();
});

test("l'onglet « Supervision » n'existe pas pour un collaborateur", async ({ browser }) => {
  const collaborateur = { uid: `supervision-${suffixe}`, email: `supervision-${suffixe}@example.org`, name: `Personne supervision ${suffixe}` };
  const page = await (await connecter(browser, collaborateur)).newPage();
  const reponse = await page.goto("/gestion/supervision");
  expect(reponse?.status()).toBe(404);
});
