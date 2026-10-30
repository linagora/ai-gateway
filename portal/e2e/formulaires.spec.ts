import { expect, type Locator, test } from "@playwright/test";
import { ADMIN, ajouterAEquipe, connecter, enrichirModele } from "./outils";

/* Champs obligatoires : une petite étoile rouge suit leur libellé, et une phrase l'explique en tête du formulaire. */
const suffixe = Date.now().toString(36);
const personne = (n: string) => ({ uid: `formulaires-${n}-${suffixe}`, email: `formulaires-${n}-${suffixe}@example.org`, name: `Personne ${n} ${suffixe}` });
const ROUGE_LINAGORA = "rgb(197, 28, 66)";
const EXPLICATION = "Les champs suivis d'une étoile (*) sont obligatoires.";

/** Libellés et légendes suivis de l'étoile, dans l'ordre de la page, sans le contenu des champs eux-mêmes. */
test.beforeAll(async ({ browser }) => {
  const context = await connecter(browser, ADMIN);
  const page = await context.newPage();
  await enrichirModele(page, { nom: "dev-public", nomAffiche: "Modèle public", niveau: "N1" });
  await page.goto("/gestion/parametres");
  await page.getByLabel("Budget par défaut (€)").fill("20");
  await page.getByLabel("Période du budget").fill("30d");
  await page.getByRole("button", { name: "Enregistrer" }).click();
  await expect(page.getByRole("status")).toHaveText("Paramètres enregistrés.");
  await context.close();
});

function obligatoires(zone: Locator): Promise<string[]> {
  return zone.locator("label > .obligatoire, legend > .obligatoire").evaluateAll((etoiles) =>
    etoiles.map((etoile) => {
      const libelle = etoile.parentElement!.cloneNode(true) as HTMLElement;
      libelle.querySelectorAll("select, textarea, input, .obligatoire").forEach((n) => n.remove());
      return (libelle.textContent ?? "").replace(/\s+/g, " ").trim();
    }),
  );
}

test("les champs obligatoires d'un salarié portent une petite étoile rouge, expliquée en tête du formulaire", async ({ browser }) => {
  const salarie = personne("salarie");
  const page = await (await connecter(browser, salarie)).newPage();
  await page.goto("/demandes/adhesion");
  await expect(page.getByText(EXPLICATION)).toBeVisible();
  expect(await obligatoires(page.locator("main"))).toEqual(["Équipe", "Motif"]);
  await expect(page.locator("label > .obligatoire").first()).toHaveCSS("color", ROUGE_LINAGORA);

  await ajouterAEquipe(salarie.uid, "R&D");
  await page.goto("/demandes/nouvelle");
  await expect(page.getByText(EXPLICATION)).toBeVisible();
  expect(await obligatoires(page.locator("main"))).toEqual([
    "Équipe",
    "Niveau de confidentialité des données que vous traiterez",
    "Modèles (niveau maximal accepté par chaque modèle)",
    "Motif",
    expect.stringMatching(/^Je m'engage/),
  ]);
  await expect(page.getByLabel("Type de clé")).toHaveCount(0);
});

test("en anglais, l'explication des étoiles est traduite", async ({ browser }) => {
  const page = await (await connecter(browser, personne("anglais"), "en-US")).newPage();
  await page.goto("/demandes/adhesion");
  await expect(page.getByText("Fields followed by an asterisk (*) are required.")).toBeVisible();
  expect(await obligatoires(page.locator("main"))).toEqual(["Team", "Reason"]);
});

test("les formulaires des admins signalent aussi leurs champs obligatoires", async ({ browser }) => {
  const admin = await (await connecter(browser, ADMIN)).newPage();
  await enrichirModele(admin, { nom: "dev-public", nomAffiche: "Modèle public", niveau: "N1" });
  await admin.goto("/gestion/catalogue");
  await expect(admin.getByText(EXPLICATION)).toHaveCount(1);
  expect(await obligatoires(admin.locator("main section").first())).toEqual([
    "Nom affiché (français)",
    "Description courte (français)",
    "Description longue (français)",
  ]);

  const salarie = personne("validation");
  const page = await (await connecter(browser, salarie)).newPage();
  await ajouterAEquipe(salarie.uid, "R&D");
  await page.goto("/demandes/nouvelle");
  await page.getByLabel("Équipe").selectOption({ label: "R&D" });
  await page.getByRole("radio", { name: /^N1 Public/ }).check();
  await page.getByLabel(/Modèle public/).check();
  await page.getByLabel("Motif").fill("Essai des champs obligatoires");
  await page.getByLabel(/Je m'engage/).check();
  await page.getByRole("button", { name: "Envoyer la demande" }).click();
  await expect(page.getByRole("status")).toHaveText("Demande envoyée aux administrateurs.");

  await admin.goto("/gestion/demandes");
  await admin.getByRole("row", { name: new RegExp(`${salarie.uid}.*Clé d'API`) }).getByRole("link", { name: "Examiner" }).click();
  await expect(admin.getByText(EXPLICATION)).toBeVisible();
  expect(await obligatoires(admin.locator("main"))).toEqual(["Modèles accordés", "Motif du refus"]);
});

test("le formulaire propose le budget recommandé ; au-delà, une justification est exigée et parvient à la fiche de validation", async ({ browser }) => {
  const salarie = personne("budget");
  const page = await (await connecter(browser, salarie)).newPage();
  await ajouterAEquipe(salarie.uid, "R&D");
  await page.goto("/demandes/nouvelle");

  const budget = page.getByLabel(/Budget \(recommandé\s: 20,00\s€ tous les 30 jours\)/);
  await expect(budget).toHaveValue("20");
  await expect(page.getByLabel("Justification du budget")).toHaveCount(0);

  await page.getByLabel("Équipe").selectOption({ label: "R&D" });
  await page.getByRole("radio", { name: /^N1 Public/ }).check();
  await page.getByLabel(/Modèle public/).check();
  await page.getByLabel("Motif").fill("Essai du budget demandé");
  await page.getByLabel(/Je m'engage/).check();

  await budget.fill("10");
  await expect(page.getByLabel("Justification du budget")).toHaveCount(0);
  await budget.fill("50");
  const justification = page.getByLabel("Justification du budget");
  await expect(justification).toBeVisible();
  await expect(justification).toHaveJSProperty("required", true);
  await page.getByRole("button", { name: "Envoyer la demande" }).click();
  await expect(justification).toHaveJSProperty("validity.valueMissing", true);
  await expect(page).toHaveURL(/\/demandes\/nouvelle/);

  await justification.fill("Traitement de longs documents pour le projet");
  await page.getByRole("button", { name: "Envoyer la demande" }).click();
  await expect(page.getByRole("status")).toHaveText("Demande envoyée aux administrateurs.");

  const admin = await (await connecter(browser, ADMIN)).newPage();
  await admin.goto("/gestion/demandes");
  await admin.getByRole("row", { name: new RegExp(`${salarie.uid}.*Clé d'API`) }).getByRole("link", { name: "Examiner" }).click();
  await expect(admin.locator("dt", { hasText: "Budget / durée" }).locator("+ dd")).toContainText(/50,00\s€/);
  await expect(admin.locator("dt", { hasText: "Justification du budget" }).locator("+ dd")).toHaveText("Traitement de longs documents pour le projet");
  await expect(admin.getByLabel("Budget (€)")).toHaveValue("50");
});
