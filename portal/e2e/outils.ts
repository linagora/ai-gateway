import { type Browser, type BrowserContext, expect } from "@playwright/test";

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
