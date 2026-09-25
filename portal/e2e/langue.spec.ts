import { expect, test } from "@playwright/test";
import { connecter } from "./outils";

/* Langue du portail (ticket #2) : langue du navigateur à la première visite, puis choix mémorisé. */
const suffixe = Date.now().toString(36);
const personne = (n: string) => ({ uid: `langue-${n}-${suffixe}`, email: `langue-${n}-${suffixe}@example.org`, name: `Personne ${n} ${suffixe}` });

test("un navigateur en anglais arrive en anglais", async ({ browser }) => {
  const context = await connecter(browser, personne("en"), "en-US");
  const page = await context.newPage();
  await page.goto("/");
  await expect(page.getByRole("heading", { name: `Hello ${personne("en").name}` })).toBeVisible();
  await expect(page.getByRole("navigation").getByRole("link", { name: "Catalog" })).toBeVisible();
  await context.close();
});

test("un navigateur sans langue reconnue par le portail arrive en français", async ({ browser }) => {
  const context = await connecter(browser, personne("de"), "de-DE");
  const page = await context.newPage();
  await page.goto("/");
  await expect(page.getByRole("heading", { name: `Bonjour ${personne("de").name}` })).toBeVisible();
  await context.close();
});

test("une même adresse s'affiche dans la langue de celui qui l'ouvre", async ({ browser }) => {
  const [francais, anglais] = await Promise.all([connecter(browser, personne("fr"), "fr-FR"), connecter(browser, personne("en2"), "en-GB")]);
  const [pageFr, pageEn] = await Promise.all([francais.newPage(), anglais.newPage()]);
  await Promise.all([pageFr.goto("/demandes"), pageEn.goto("/demandes")]);
  await expect(pageFr.getByRole("navigation").getByRole("link", { name: "Mes demandes" })).toBeVisible();
  await expect(pageEn.getByRole("navigation").getByRole("link", { name: "My requests" })).toBeVisible();
  await Promise.all([francais.close(), anglais.close()]);
});

test("le sélecteur FR | EN change la langue, et le choix persiste d'une visite à l'autre", async ({ browser }) => {
  const context = await connecter(browser, personne("choix"), "fr-FR");
  const page = await context.newPage();
  await page.goto("/");
  await page.getByRole("button", { name: "English" }).click();
  await expect(page.getByRole("heading", { name: `Hello ${personne("choix").name}` })).toBeVisible();
  const visiteSuivante = await context.newPage();
  await visiteSuivante.goto("/demandes");
  await expect(visiteSuivante.getByRole("navigation").getByRole("link", { name: "My requests" })).toBeVisible();
  await visiteSuivante.getByRole("button", { name: "Français" }).click();
  await expect(visiteSuivante.getByRole("navigation").getByRole("link", { name: "Mes demandes" })).toBeVisible();
  await context.close();
});

test("les prix suivent le format de la langue", async ({ browser }) => {
  const admin = { uid: "mmaudet", email: "mmaudet@linagora.com", name: "Admin E2E" };
  for (const [langueNavigateur, prix] of [["fr-FR", /0,10\s€/], ["en-US", /€0\.10/]] as const) {
    const context = await connecter(browser, admin, langueNavigateur);
    const page = await context.newPage();
    await page.goto("/gestion/catalogue");
    await expect(page.locator("section").filter({ has: page.locator("code", { hasText: /^dev-public$/ }) })).toContainText(prix);
    await context.close();
  }
});
