import { expect, test } from "@playwright/test";
import { ADMIN, connecter, demandeApprouvee, enrichirModele, retirerCle } from "./outils";

/* Configuration d'OpenCode à partir des clés émises (tickets #113 à #117). La passerelle de développement répond par des modèles simulés. */
const suffixe = Date.now().toString(36);
const personne = (n: string) => ({ uid: `opencode-${n}-${suffixe}`, email: `opencode-${n}-${suffixe}@example.org`, name: `Personne ${n} ${suffixe}` });

test.beforeAll(async ({ browser }) => {
  const context = await connecter(browser, ADMIN);
  const page = await context.newPage();
  await enrichirModele(page, { nom: "dev-public", nomAffiche: "Modèle public", niveau: "N1" });
  // Comme le catalogue de démonstration : le modèle interne est recommandé pour le code.
  await enrichirModele(page, { nom: "dev-interne", nomAffiche: "Modèle interne", niveau: "N2", casUsage: ["Rédaction et analyse", "Code"], recommandePour: ["Code"] });
  await context.close();
});

test("depuis « Mes clés », le titulaire ouvre la configuration d'OpenCode de sa clé : ses modèles y sont, jamais la clé", async ({ browser }) => {
  const salarie = personne("cle");
  const page = await (await connecter(browser, salarie)).newPage();
  await demandeApprouvee(browser, page, salarie, "Essai OpenCode");
  const cle = await retirerCle(page);

  const carte = page.getByRole("region", { name: "Clés émises" }).getByRole("article");
  await carte.getByText("Comment l'utiliser").click();
  await carte.getByRole("link", { name: "Configurer OpenCode avec cette clé" }).click();

  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Configurer OpenCode");
  await expect(page.getByRole("checkbox", { name: new RegExp(`^${salarie.uid}-r-d-essai-opencode-`) })).toBeChecked();
  const configuration = page.getByRole("region", { name: "Enregistrer la configuration" });
  await expect(configuration).toContainText('"linagora-n1-r-d-essai-opencode": {');
  await expect(configuration).toContainText('"name": "LINAGORA · N1 Public · R&D · Essai OpenCode"');
  await expect(configuration).toContainText('"modelID": "dev-public"');
  await expect(configuration).toContainText('"apiKey": "{env:LINAGORA_N1_R_D_ESSAI_OPENCODE_KEY}"');
  // Ticket #115 : coût en dollars, converti au taux interne, que la page explique.
  await expect(configuration).toContainText('"cost": [');
  await expect(configuration).toContainText("OpenCode affiche les coûts en dollars");
  await expect(page.getByRole("region", { name: "Enregistrer vos clés" })).toContainText('opencode service set env LINAGORA_N1_R_D_ESSAI_OPENCODE_KEY "$K"');
  expect(await page.content()).not.toContain(cle);
});

test("le modèle par défaut et la politique de mise à jour choisis s'écrivent en tête de la configuration (ticket #116)", async ({ browser }) => {
  const salarie = personne("defaut");
  const page = await (await connecter(browser, salarie)).newPage();
  await demandeApprouvee(browser, page, salarie, "Essai défaut");
  await retirerCle(page);

  await page.goto("/cles/opencode");
  await page.getByLabel("Modèle par défaut").selectOption({ label: "Modèle public" });
  await expect(page).toHaveURL(/modele=/);
  await page.getByLabel("Mises à jour d'OpenCode").selectOption({ label: "Les installer automatiquement" });
  const configuration = page.getByRole("region", { name: "Enregistrer la configuration" });
  await expect(configuration).toContainText('"model": "linagora-n1-r-d-essai-defaut/dev-public"');
  await expect(configuration).toContainText('"update": "auto"');
});

test("sans clé, la page donne les étapes pour en obtenir une et les modèles recommandés pour le code (ticket #117)", async ({ browser }) => {
  const salarie = personne("sans-cle");
  const page = await (await connecter(browser, salarie)).newPage();

  await page.goto("/cles/opencode");
  await expect(page.getByText("il vous faut une clé émise avec au moins un modèle de conversation")).toBeVisible();
  await expect(page.getByRole("link", { name: "Faire une demande de clé" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Modèles recommandés pour le code" })).toContainText("Modèle interne · N2 Interne");
});

test("en anglais, le tutoriel guide pas à pas, avec le rappel des niveaux de confidentialité (ticket #117)", async ({ browser }) => {
  const salarie = personne("anglais");
  const page = await (await connecter(browser, salarie)).newPage();
  await demandeApprouvee(browser, page, salarie, "Essai anglais");
  await retirerCle(page);

  const anglais = await (await connecter(browser, salarie, "en-US")).newPage();
  await anglais.goto("/cles/opencode");
  await expect(anglais.getByRole("heading", { level: 1 })).toHaveText("Set up OpenCode");
  await expect(anglais.getByRole("heading", { level: 2 })).toHaveText(["1Install OpenCode", "2Choose your keys", "3Save the configuration", "4Save your keys", "5Use OpenCode"]);
  await expect(anglais.getByRole("region", { name: "Install OpenCode" })).toContainText("curl -fsSL https://opencode.ai/v2/install | bash");
  await expect(anglais.getByRole("region", { name: "Choose your keys" })).toContainText("N3 Confidential: secret code or code of a customer");
  await expect(anglais.getByRole("region", { name: "Save the configuration" })).toContainText('"name": "LINAGORA · N1 Public · R&D · Essai anglais"');
  await expect(anglais.getByRole("region", { name: "Save your keys" })).toContainText(`LINAGORA key ${salarie.uid}-r-d-essai-anglais-`);
});
