import { type Browser, expect, type Page, test } from "@playwright/test";

/*
 * Parcours principal (PRD §9, critères 4, 5 et 6 jusqu'à l'approbation) avec deux sessions :
 * un admin (PORTAL_ADMIN_UIDS=mmaudet dans .env) et un salarié créé pour l'occasion.
 */
const suffix = Date.now().toString(36);
const admin = { uid: "mmaudet", email: "mmaudet@linagora.com", name: "Admin E2E" };
const salarie = { uid: `e2e-${suffix}`, email: `e2e-${suffix}@example.org`, name: `Salarié ${suffix}` };

test.describe.configure({ mode: "serial" });

let adminPage: Page;
let salariePage: Page;

async function login(browser: Browser, user: typeof admin): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto("/");
  await page.getByRole("button", { name: /LemonLDAP/ }).click();
  // Formulaire du fournisseur OIDC simulé : uid (= sub) et claims.
  await page.locator('input[name="username"]').fill(user.uid);
  await page.locator('textarea[name="claims"]').fill(JSON.stringify({ email: user.email, name: user.name }));
  await page.getByRole("button", { name: "Sign-in" }).click();
  await expect(page.getByRole("heading", { name: `Bonjour ${user.name}` })).toBeVisible();
  return page;
}

function modelSection(page: Page, modelName: string) {
  return page.locator("section").filter({ has: page.locator("code", { hasText: new RegExp(`^${modelName}$`) }) });
}

test.beforeAll(async ({ browser }) => {
  adminPage = await login(browser, admin);
  salariePage = await login(browser, salarie);
});

test("un admin enrichit le catalogue et fixe les valeurs par défaut", async () => {
  for (const [modelName, displayName, level] of [
    ["dev-public", "Modèle public", "N1"],
    ["dev-interne", "Modèle interne", "N2"],
    ["dev-confidentiel", "Modèle confidentiel", "N3"],
  ]) {
    await adminPage.goto("/gestion/catalogue");
    const section = modelSection(adminPage, modelName);
    await section.getByLabel("Nom affiché").fill(displayName);
    await section.getByLabel("Description").fill(`Modèle de démonstration ${level}`);
    await section.getByLabel("Niveau maximal de données").selectOption(level);
    await section.getByLabel("Visible des utilisateurs").check();
    await section.getByRole("button", { name: "Enregistrer" }).click();
    await expect(adminPage.getByRole("status")).toHaveText("Catalogue mis à jour.");
  }
  await adminPage.goto("/gestion/parametres");
  await adminPage.getByLabel("Budget par défaut (€)").fill("10");
  await adminPage.getByLabel("Période du budget (ex. 30d)").fill("30d");
  await adminPage.getByLabel("Durée de validité par défaut (jours)").fill("30");
  await adminPage.getByRole("button", { name: "Enregistrer" }).click();
  await expect(adminPage.getByRole("status")).toHaveText("Paramètres enregistrés.");
});

test("un salarié demande à rejoindre l'équipe R&D et un admin l'y ajoute (F-22)", async () => {
  await salariePage.goto("/demandes/adhesion");
  await salariePage.getByLabel("Équipe").selectOption({ label: "R&D" });
  await salariePage.getByLabel("Motif").fill("Rejoindre le projet de démonstration");
  await salariePage.getByRole("button", { name: "Envoyer la demande" }).click();
  await expect(salariePage.getByRole("status")).toHaveText("Demande d'adhésion envoyée.");

  await adminPage.goto("/gestion/demandes");
  await adminPage.getByRole("row", { name: new RegExp(`${salarie.uid}.*Adhésion`) }).getByRole("link", { name: "Examiner" }).click();
  await adminPage.getByRole("button", { name: /Approuver : ajouter/ }).click();
  await expect(adminPage.getByRole("status")).toHaveText("Adhésion approuvée : le demandeur a été ajouté à l'équipe.");
});

test("critère 4 : le salarié voit le catalogue et soumet une demande N2", async () => {
  await salariePage.goto("/catalogue");
  await expect(salariePage.getByRole("cell", { name: /Modèle interne/ })).toBeVisible();

  await salariePage.goto("/demandes/nouvelle");
  await salariePage.getByLabel("Équipe").selectOption({ label: "R&D" });
  await salariePage.getByRole("radio", { name: /^N2 — Interne/ }).check();
  await salariePage.getByLabel(/Modèle interne/).check();
  await salariePage.getByLabel("Motif").fill("Rédaction de comptes rendus internes");
  await salariePage.getByLabel(/Je m'engage/).check();
  await salariePage.getByRole("button", { name: "Envoyer la demande" }).click();
  await expect(salariePage.getByRole("status")).toHaveText("Demande envoyée aux administrateurs.");
  await expect(salariePage.getByRole("row", { name: /Clé d'API.*R&D.*N2 — Interne.*dev-interne.*Soumise/ })).toBeVisible();
});

test("critère 5 : une demande N3 incluant un modèle N2 est refusée côté serveur", async () => {
  await salariePage.goto("/demandes/nouvelle");
  await salariePage.getByLabel("Équipe").selectOption({ label: "R&D" });
  await salariePage.getByRole("radio", { name: /^N3 — Confidentiel/ }).check();
  await salariePage.getByLabel(/Modèle interne/).check();
  await salariePage.getByLabel("Motif").fill("Analyse de contrats");
  await salariePage.getByLabel(/Je m'engage/).check();
  await salariePage.getByRole("button", { name: "Envoyer la demande" }).click();
  await expect(salariePage.getByRole("main").getByRole("alert")).toContainText("Les modèles acceptent le niveau de données déclaré (dev-interne)");
});

test("un admin approuve la demande N2 et le salarié la voit approuvée", async () => {
  await adminPage.goto("/gestion/demandes");
  await adminPage.getByRole("row", { name: new RegExp(`${salarie.uid}.*Clé d'API`) }).getByRole("link", { name: "Examiner" }).click();
  await expect(adminPage.getByText("✘")).toHaveCount(0);
  await adminPage.getByRole("button", { name: "Approuver", exact: true }).click();
  await expect(adminPage.getByRole("status")).toHaveText("Demande approuvée.");

  await salariePage.goto("/demandes");
  await expect(salariePage.getByRole("row", { name: /Clé d'API.*R&D.*Approuvée/ })).toBeVisible();
});
