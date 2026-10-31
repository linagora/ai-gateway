import { expect, test as setup } from "@playwright/test";
import { ADMIN, connecter } from "./outils";

/*
 * Valeurs par défaut des clés, posées avant tous les parcours (projet « reglages » de playwright.config.ts). Sur une base
 * neuve, comme celle de la CI, aucune n'existe : les parcours qui ne les posent pas eux-mêmes dépendaient de celles qu'avait
 * laissées un autre fichier ou la base de dev. Ce sont les valeurs de production : 20 € par 30 jours, clés de 90 jours,
 * retrait sous 14 jours.
 */
setup("valeurs par défaut des clés", async ({ browser }) => {
  const context = await connecter(browser, ADMIN);
  const page = await context.newPage();
  await page.goto("/gestion/parametres");
  await page.getByLabel("Budget par défaut (€)").fill("20");
  await page.getByLabel("Période du budget").fill("30d");
  await page.getByLabel("Durée de validité par défaut (jours)").fill("90");
  await page.getByLabel("Délai de retrait d'une clé approuvée (jours)").fill("14");
  await page.getByRole("button", { name: "Enregistrer" }).click();
  await expect(page.getByRole("status")).toHaveText("Paramètres enregistrés.");
  await context.close();
});
