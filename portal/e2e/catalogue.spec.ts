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

test("l'admin complète une fiche en anglais, coche ses cas d'usage et voit les faits techniques (ticket #6)", async ({ browser }) => {
  const context = await connecter(browser, ADMIN);
  const page = await context.newPage();
  await page.goto("/gestion/catalogue");
  const fiche = () => page.locator("section").filter({ has: page.locator("code", { hasText: /^dev-confidentiel$/ }) });
  await expect(fiche()).toContainText("Alibaba (Qwen)");
  await expect(fiche()).toContainText("OVHcloud");
  await fiche().getByLabel("Nom affiché (anglais)").fill("Confidential model");
  await fiche().getByRole("group", { name: "Cas d'usage" }).getByLabel("Rédaction et synthèse").check();
  await fiche().getByRole("group", { name: "Recommandé pour" }).getByLabel("Rédaction et synthèse").check();
  await fiche().getByRole("button", { name: "Enregistrer" }).click();
  await expect(page.getByRole("status")).toHaveText("Catalogue mis à jour.");
  await expect(fiche().getByLabel("Nom affiché (anglais)")).toHaveValue("Confidential model");
  await expect(fiche().getByRole("group", { name: "Recommandé pour" }).getByLabel("Rédaction et synthèse")).toBeChecked();

  // Une recommandation pour un cas d'usage non coché est refusée.
  await fiche().getByRole("group", { name: "Recommandé pour" }).getByLabel("Code").check();
  await fiche().getByRole("button", { name: "Enregistrer" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("cas d'usage coché");
  await context.close();

  const anglais = await connecter(browser, ADMIN, "en-US");
  const pageEn = await anglais.newPage();
  await pageEn.goto("/gestion/catalogue");
  const ficheEn = pageEn.locator("section").filter({ has: pageEn.locator("code", { hasText: /^dev-confidentiel$/ }) });
  await expect(ficheEn.getByLabel("Display name (English)")).toHaveValue("Confidential model");
  await ficheEn.getByRole("button", { name: "Save" }).click();
  await expect(pageEn.getByRole("status")).toHaveText("Catalog updated.");
  await anglais.close();
});
