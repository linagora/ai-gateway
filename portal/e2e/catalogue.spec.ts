import { expect, test } from "@playwright/test";
import { ADMIN, connecter, enrichirModele } from "./outils";

/* Catalogue des salariés (spécification #1). */
const suffixe = Date.now().toString(36);
const salarie = { uid: `catalogue-${suffixe}`, email: `catalogue-${suffixe}@example.org`, name: `Salarié ${suffixe}` };

test.beforeAll(async ({ browser }) => {
  const context = await connecter(browser, ADMIN);
  const page = await context.newPage();
  for (const [nom, nomAffiche, niveau] of [
    ["dev-public", "Modèle public", "N1"],
    ["dev-interne", "Modèle interne", "N2"],
    ["dev-confidentiel", "Modèle confidentiel", "N3"],
    ["dev-experimental", "Modèle expérimental", "EXP"],
  ]) {
    await enrichirModele(page, { nom, nomAffiche, niveau });
  }
  await context.close();
});

test("le catalogue montre l'éditeur et la zone d'exécution, jamais le fournisseur « openai » (ticket #3)", async ({ browser }) => {
  const context = await connecter(browser, salarie);
  const page = await context.newPage();
  await page.goto("/catalogue");
  await expect(page.getByRole("row", { name: /Modèle interne/ }).getByRole("cell").first()).toContainText("Mistral AI · UE");
  await expect(page.getByRole("row", { name: /Modèle public/ }).getByRole("cell").first()).toContainText("Moonshot AI · Hors UE");
  await expect(page.getByRole("main")).not.toContainText("openai");
  await context.close();
});
