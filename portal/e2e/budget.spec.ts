import { expect, type Page, test } from "@playwright/test";
import { ADMIN, appel, connecter, demandeApprouvee, demanderEtApprouver, designer, echapper, ligneDeLaFile, nouvelleEquipe, type Personne, retirerCle } from "./outils";

/* Hausse du budget d'une clé émise, sans changer la clé. Les clés approuvées par `demandeApprouvee` ont 5 € par 30 jours. */
const suffixe = Date.now().toString(36);
const personne = (n: string): Personne => ({ uid: `budget-${n}-${suffixe}`, email: `budget-${n}-${suffixe}@example.org`, name: `Personne ${n} ${suffixe}` });

/** Carte de la clé du salarié dans « Mes clés », retrouvée par son alias (uid-équipe-projet-…). */
const carteDeLaCle = (page: Page, salarie: Personne, projet: string, equipe = "r-d") =>
  page.getByRole("region", { name: "Clés émises" }).getByRole("article", { name: new RegExp(`^${echapper(salarie.uid)}-${equipe}-${projet}-`) });

/** Depuis la carte de la clé, le titulaire demande à porter son budget à ce montant. */
async function demanderHausse(page: Page, carte: ReturnType<typeof carteDeLaCle>, montant: string, justification: string): Promise<void> {
  await page.goto("/cles");
  await carte.getByRole("link", { name: "Demander plus de budget" }).click();
  await page.getByLabel("Nouveau budget (€)").fill(montant);
  await page.getByLabel("Justification").fill(justification);
  await page.getByRole("button", { name: "Envoyer la demande" }).click();
  await expect(page.getByRole("status")).toHaveText("Demande envoyée.");
}

test("le titulaire demande plus de budget pour sa clé ; approuvé, le plafond de la même clé est relevé (demande de budget)", async ({ browser, request }) => {
  const salarie = personne("hausse");
  const page = await (await connecter(browser, salarie)).newPage();
  await demandeApprouvee(browser, page, salarie, "Essai hausse");
  const cle = await retirerCle(page);
  expect(await appel(request, cle)).toBe(200);
  const carte = carteDeLaCle(page, salarie, "essai-hausse");
  await expect(carte).toContainText("sur 5,00 €");
  const alias = ((await carte.getByRole("heading").textContent()) ?? "").trim();

  await page.goto("/cles");
  await carte.getByRole("link", { name: "Demander plus de budget" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText(alias);
  const plafond = page.locator("dt", { hasText: "Plafond actuel" }).locator("xpath=following-sibling::dd[1]");
  await expect(plafond).toContainText("5,00 €");
  await expect(plafond).toContainText("tous les 30 jours");
  await expect(page.getByLabel("Nouveau budget (€)")).toHaveAttribute("min", "5.01");
  await page.getByLabel("Nouveau budget (€)").fill("50.5");
  await page.getByLabel("Justification").fill("Chantier de migration");
  await page.getByRole("button", { name: "Envoyer la demande" }).click();
  await expect(page.getByRole("status")).toHaveText("Demande envoyée.");

  await expect(page).toHaveURL(/\/demandes\?ok=budgetDemande$/);
  const ligne = page.getByRole("row", { name: /Hausse de budget/ });
  await expect(ligne).toContainText(alias);
  await expect(ligne).toContainText("Soumise");

  const admin = await (await connecter(browser, ADMIN)).newPage();
  await admin.goto("/gestion/demandes");
  await ligneDeLaFile(admin, "À approuver", salarie).filter({ hasText: "Hausse de budget" }).getByRole("link", { name: "Examiner" }).click();
  const valeur = (intitule: string) => admin.locator("dt", { hasText: intitule }).locator("xpath=following-sibling::dd[1]");
  await expect(valeur("Clé visée")).toContainText(alias);
  await expect(valeur("Plafond actuel")).toHaveText("5,00 €, tous les 30 jours");
  await expect(valeur("Montant demandé")).toContainText("50,50 €");
  await expect(valeur("Motif")).toHaveText("Chantier de migration");
  await expect(admin.getByRole("heading", { name: "Contrôles de politique" })).toHaveCount(0);
  await expect(admin.getByLabel("Nouveau budget (€)")).toHaveValue("50.5");

  await admin.getByLabel("Nouveau budget (€)").fill("40");
  await admin.getByRole("button", { name: "Relever le budget" }).click();
  await expect(admin.getByRole("status")).toHaveText("Budget relevé.");
  await expect(ligneDeLaFile(admin, "À approuver", salarie)).toHaveCount(0);

  await page.goto("/cles");
  await expect(carteDeLaCle(page, salarie, "essai-hausse")).toContainText("sur 40,00 €");
  expect(await appel(request, cle)).toBe(200);
});

test("une hausse demandée par un responsable sur sa propre clé n'est pas dans sa file", async ({ browser }) => {
  const responsable = personne("responsable");
  const pageResponsable = await (await connecter(browser, responsable)).newPage();
  const admin = await (await connecter(browser, ADMIN)).newPage();
  const equipe = `Équipe hausse ${suffixe}`;
  await nouvelleEquipe(admin, equipe);
  await designer(admin, responsable.uid);

  await demanderEtApprouver(browser, pageResponsable, responsable, { equipe, projet: "Hausse responsable" });
  await retirerCle(pageResponsable);
  const carte = pageResponsable.getByRole("region", { name: "Clés émises" }).getByRole("article");
  await demanderHausse(pageResponsable, carte, "20", "Besoin ponctuel");

  await pageResponsable.goto("/gestion/demandes");
  await expect(pageResponsable.getByRole("row", { name: /Hausse de budget/ })).toHaveCount(0);

  await admin.goto("/gestion/demandes");
  await expect(ligneDeLaFile(admin, "À approuver", responsable).filter({ hasText: "Hausse de budget" })).toHaveCount(1);
});
