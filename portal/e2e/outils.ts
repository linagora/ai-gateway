import { type Browser, type BrowserContext, expect, type Page } from "@playwright/test";

export interface Personne {
  uid: string;
  email: string;
  name: string;
}

/** Ouvre une session dans un contexte de navigateur réglé sur la langue donnée (en-tête Accept-Language). */
export async function connecter(browser: Browser, personne: Personne, langueNavigateur = "fr-FR"): Promise<BrowserContext> {
  const context = await browser.newContext({ locale: langueNavigateur });
  const page = await context.newPage();
  await page.goto("/");
  await page.getByRole("button", { name: /LemonLDAP/ }).click();
  // Formulaire du fournisseur OIDC simulé : uid (= sub) et claims.
  await page.locator('input[name="username"]').fill(personne.uid);
  await page.locator('textarea[name="claims"]').fill(JSON.stringify({ email: personne.email, name: personne.name }));
  await page.getByRole("button", { name: "Sign-in" }).click();
  await expect(page.getByRole("heading", { name: new RegExp(personne.name) })).toBeVisible();
  await page.close();
  return context;
}

export const ADMIN: Personne = { uid: "mmaudet", email: "mmaudet@linagora.com", name: "Admin E2E" };

/** Enrichit un modèle de démonstration depuis la gestion du catalogue (session admin), et le rend visible. */
export async function enrichirModele(page: Page, modele: { nom: string; nomAffiche: string; niveau: string }): Promise<void> {
  await page.goto("/gestion/catalogue");
  const section = page.locator("section").filter({ has: page.locator("code", { hasText: new RegExp(`^${modele.nom}$`) }) });
  await section.getByLabel("Nom affiché (français)").fill(modele.nomAffiche);
  await section.getByLabel("Description courte (français)").fill(`Modèle de démonstration ${modele.niveau}`);
  await section.getByLabel("Description longue (français)").fill(`Modèle de démonstration ${modele.niveau}, à réponses simulées.`);
  await section.getByLabel("Niveau maximal").selectOption(modele.niveau);
  await section.getByLabel("Visible des salariés").check();
  await section.getByRole("button", { name: "Enregistrer" }).click();
  await expect(page.getByRole("status")).toHaveText("Catalogue mis à jour.");
}
