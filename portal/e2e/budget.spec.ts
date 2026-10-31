import { expect, type Page, test } from "@playwright/test";
import {
  ADMIN,
  ajouterAEquipe,
  appel,
  connecter,
  courriels,
  demandeApprouvee,
  demanderComplement,
  demanderEtApprouver,
  designer,
  echapper,
  forcerDepense,
  infoCle,
  ligneDeLaFile,
  nouvelleEquipe,
  PASSERELLE,
  type Personne,
  refuser,
  retirerCle,
} from "./outils";

/* Budget d'une clé : demandé à la création, puis relevé sans changer la clé. Les clés approuvées par `demandeApprouvee` ont 5 € par 30 jours. */
const suffixe = Date.now().toString(36);
const personne = (n: string): Personne => ({ uid: `budget-${n}-${suffixe}`, email: `budget-${n}-${suffixe}@example.org`, name: `Personne ${n} ${suffixe}` });

test.beforeAll(async ({ browser }) => {
  const context = await connecter(browser, ADMIN);
  const page = await context.newPage();
  await page.goto("/gestion/parametres");
  await page.getByLabel("Budget par défaut (€)").fill("20");
  await page.getByLabel("Période du budget").fill("30d");
  await page.getByRole("button", { name: "Enregistrer" }).click();
  await expect(page.getByRole("status")).toHaveText("Paramètres enregistrés.");
  await context.close();
});

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

/** Depuis la file de l'admin, ouvre la fiche de la hausse de budget du salarié. */
async function examinerHausse(admin: Page, salarie: Personne): Promise<void> {
  await admin.goto("/gestion/demandes");
  await ligneDeLaFile(admin, "À approuver", salarie).filter({ hasText: "Hausse de budget" }).getByRole("link", { name: "Examiner" }).click();
}

/** Courriels de Mailpit liés à la personne, dont le sujet contient ce texte. */
const courrielsSujet = async (recherche: string, sujet: string) => (await courriels(recherche)).filter((c) => c.subject.includes(sujet));

test("budget demandé à la création : justifié, approuvé, appliqué par la passerelle à la clé retirée", async ({ browser, request }) => {
  const salarie = personne("creation");
  const page = await (await connecter(browser, salarie)).newPage();
  await ajouterAEquipe(salarie.uid, "R&D");
  await page.goto("/demandes/nouvelle");
  await page.getByLabel("Équipe").selectOption({ label: "R&D" });
  await page.getByRole("radio", { name: /^N1 Public/ }).check();
  await page.getByLabel(/Modèle public/).check();
  await page.getByLabel("Motif").fill("Essai du budget justifié");
  await page.getByLabel("Projet ou affaire").fill("Essai creation");
  await page.getByLabel(/Je m'engage/).check();
  await page.getByLabel(/^Budget \(recommandé/).fill("50");
  await page.getByLabel("Justification du budget").fill("Traitement de longs documents");
  await page.getByRole("button", { name: "Envoyer la demande" }).click();
  await expect(page.getByRole("status")).toHaveText("Demande envoyée aux administrateurs.");

  await expect.poll(async () => (await courrielsSujet(salarie.uid, "Nouvelle demande de clé d'API")).length, { timeout: 15_000 }).toBeGreaterThan(0);
  const [annonce] = await courrielsSujet(salarie.uid, "Nouvelle demande de clé d'API");
  expect(annonce.to).toContain("admins-e2e@example.org");
  expect(annonce.text).toMatch(/Budget souhaité\s*:\s*50,00\s€/);
  expect(annonce.text).toContain("Traitement de longs documents");

  const admin = await (await connecter(browser, ADMIN)).newPage();
  await admin.goto("/gestion/demandes");
  await admin.getByRole("row", { name: new RegExp(`${salarie.uid}.*Clé d'API`) }).getByRole("link", { name: "Examiner" }).click();
  await expect(admin.getByLabel("Budget (€)")).toHaveValue("50");
  await admin.getByLabel("Période du budget (ex. 30d)").fill("30d");
  await admin.getByLabel("Durée de validité").selectOption({ label: "1 mois" });
  await admin.getByRole("button", { name: "Approuver", exact: true }).click();
  await expect(admin.getByRole("status")).toHaveText("Demande approuvée.");

  const cle = await retirerCle(page);
  expect((await infoCle(cle)).maxBudget).toBe(50);
  expect(await appel(request, cle)).toBe(200);
});

test("budget épuisé, hausse demandée et approuvée : la même clé refonctionne, sans perdre sa dépense", async ({ browser, request }) => {
  const salarie = personne("hausse");
  const page = await (await connecter(browser, salarie)).newPage();
  await demandeApprouvee(browser, page, salarie, "Essai hausse");
  const cle = await retirerCle(page);
  expect(await appel(request, cle)).toBe(200);
  const carte = carteDeLaCle(page, salarie, "essai-hausse");
  await expect(carte).toContainText("sur 5,00 €");
  const alias = ((await carte.getByRole("heading").textContent()) ?? "").trim();

  await forcerDepense(cle, 5);
  const refus = await request.post(PASSERELLE, { headers: { Authorization: `Bearer ${cle}` }, data: { model: "dev-public", messages: [{ role: "user", content: "Bonjour" }] } });
  expect(refus.status()).toBe(429);
  expect(await refus.text()).toContain("budget_exceeded");
  const avant = await infoCle(cle);
  expect(avant.maxBudget).toBe(5);
  expect(avant.spend).toBeCloseTo(5, 2);

  await page.goto("/cles");
  await carte.getByRole("link", { name: "Demander plus de budget" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText(alias);
  const plafond = page.locator("dt", { hasText: "Plafond actuel" }).locator("xpath=following-sibling::dd[1]");
  await expect(plafond).toContainText("5,00 €");
  await expect(plafond).toContainText("tous les 30 jours");
  await expect(page.getByLabel("Nouveau budget (€)")).toHaveAttribute("min", "5.01");
  // Sans le minimum de la saisie, le serveur refuse un plafond qui ne dépasse pas l'actuel, écrit au format monétaire.
  await page.getByLabel("Nouveau budget (€)").evaluate((champ) => champ.removeAttribute("min"));
  await page.getByLabel("Nouveau budget (€)").fill("5");
  await page.getByLabel("Justification").fill("Chantier de migration");
  await page.getByRole("button", { name: "Envoyer la demande" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toHaveText("Le montant doit dépasser le plafond actuel de la clé (5,00 €).");
  await page.getByLabel("Nouveau budget (€)").fill("20.5");
  await page.getByLabel("Justification").fill("Chantier de migration");
  await page.getByRole("button", { name: "Envoyer la demande" }).click();
  await expect(page.getByRole("status")).toHaveText("Demande envoyée.");

  await expect(page).toHaveURL(/\/demandes\?ok=budgetDemande$/);
  const ligne = page.getByRole("row", { name: /Hausse de budget/ });
  await expect(ligne).toContainText(alias);
  await expect(ligne).toContainText("Soumise");

  await expect.poll(async () => (await courrielsSujet(salarie.uid, "hausse de budget")).length, { timeout: 15_000 }).toBeGreaterThan(0);
  const [annonce] = await courrielsSujet(salarie.uid, "hausse de budget");
  expect(annonce.to).toContain("admins-e2e@example.org");
  expect(annonce.text).toContain(alias);
  expect(annonce.text).toContain("Chantier de migration");
  expect(annonce.text).toMatch(/Budget souhaité\s*:\s*20,50\s€/);

  const admin = await (await connecter(browser, ADMIN)).newPage();
  await admin.goto("/gestion/demandes");
  await expect(ligneDeLaFile(admin, "À approuver", salarie).filter({ hasText: "Hausse de budget" })).toContainText(alias);
  await examinerHausse(admin, salarie);
  const valeur = (intitule: string) => admin.locator("dt", { hasText: intitule }).locator("xpath=following-sibling::dd[1]");
  await expect(valeur("Clé visée")).toContainText(alias);
  await expect(valeur("Plafond actuel")).toHaveText("5,00 €, tous les 30 jours");
  await expect(valeur("Montant demandé")).toHaveText("20,50 €");
  await expect(valeur("Motif")).toHaveText("Chantier de migration");
  await expect(admin.getByRole("heading", { name: "Contrôles de politique" })).toHaveCount(0);
  await expect(admin.getByLabel("Nouveau budget (€)")).toHaveValue("20.5");

  await admin.getByLabel("Nouveau budget (€)").fill("15.5");
  await admin.getByRole("button", { name: "Relever le budget" }).click();
  await expect(admin.getByRole("status")).toHaveText("Budget relevé.");
  await expect(ligneDeLaFile(admin, "À approuver", salarie)).toHaveCount(0);
  // Approuvée, la hausse montre le montant accordé dans l'archive, et sur sa fiche à côté du montant demandé.
  const archivee = ligneDeLaFile(admin, "Archive : demandes traitées", salarie).filter({ hasText: "Hausse de budget" });
  await expect(archivee).toContainText("Montant accordé : 15,50 €");
  await archivee.getByRole("link", { name: "Voir" }).click();
  await expect(valeur("Montant demandé")).toHaveText("20,50 €");
  await expect(valeur("Montant accordé")).toHaveText("15,50 €");

  await expect.poll(async () => (await courrielsSujet(salarie.uid, "est relevé")).length, { timeout: 15_000 }).toBeGreaterThan(0);
  const [releve] = await courrielsSujet(salarie.uid, "est relevé");
  expect(releve.to).toEqual([salarie.email]);
  expect(releve.text).toContain(alias);
  expect(releve.text).toMatch(/relevé à 15,50\s€/);

  const apres = await infoCle(cle);
  expect(apres).toMatchObject({ maxBudget: 15.5, budgetResetAt: avant.budgetResetAt, expires: avant.expires });
  expect(apres.spend).toBeCloseTo(5, 2);
  expect(await appel(request, cle)).toBe(200);
  await page.goto("/cles");
  await expect(carteDeLaCle(page, salarie, "essai-hausse")).toContainText("sur 15,50 €");
  await expect(carteDeLaCle(page, salarie, "essai-hausse").getByRole("heading")).toHaveText(alias);
});

test("hausse refusée puis redemandée, complétée, annulée : le plafond ne bouge pas", async ({ browser }) => {
  const salarie = personne("refus");
  const page = await (await connecter(browser, salarie)).newPage();
  await demandeApprouvee(browser, page, salarie, "Essai refus");
  const cle = await retirerCle(page);
  const carte = carteDeLaCle(page, salarie, "essai-refus");
  const admin = await (await connecter(browser, ADMIN)).newPage();

  await demanderHausse(page, carte, "20", "Premier besoin");
  await examinerHausse(admin, salarie);
  await refuser(admin, "Budget non justifié");
  await expect.poll(async () => (await courrielsSujet(salarie.uid, "refusée")).length, { timeout: 15_000 }).toBeGreaterThan(0);
  const [refus] = await courrielsSujet(salarie.uid, "refusée");
  expect(refus.to).toEqual([salarie.email]);
  expect(refus.text).toContain("hausse du budget");
  expect(refus.text).toContain("Budget non justifié");
  expect((await infoCle(cle)).maxBudget).toBe(5);

  await demanderHausse(page, carte, "20", "Second besoin");
  await examinerHausse(admin, salarie);
  await demanderComplement(admin, "Précisez le projet concerné");

  await page.goto("/demandes");
  await page.getByRole("row", { name: /Hausse de budget.*À compléter/ }).getByRole("link", { name: "Compléter" }).click();
  await expect(page.getByLabel("Justification")).toHaveValue("Second besoin");
  await page.getByLabel("Justification").fill("Second besoin : projet de migration");
  await page.getByRole("button", { name: "Compléter et renvoyer la demande" }).click();
  await expect(page.getByRole("status")).toHaveText("Demande complétée et resoumise.");
  await expect(page.getByRole("row", { name: /Hausse de budget.*Soumise/ })).toBeVisible();

  await page.getByRole("row", { name: /Hausse de budget.*Soumise/ }).getByRole("button", { name: "Annuler" }).click();
  await expect(page.getByRole("status")).toHaveText("Demande annulée.");
  await expect(page.getByRole("row", { name: /Hausse de budget.*Annulée/ })).toBeVisible();
  expect((await infoCle(cle)).maxBudget).toBe(5);
});

test("une hausse en cours bloque le renouvellement, et la révocation de la clé l'annule", async ({ browser }) => {
  const salarie = personne("blocage");
  const page = await (await connecter(browser, salarie)).newPage();
  await demandeApprouvee(browser, page, salarie, "Essai blocage");
  await retirerCle(page);
  const carte = carteDeLaCle(page, salarie, "essai-blocage");
  await demanderHausse(page, carte, "20", "Besoin en cours");

  await page.goto("/cles");
  await carte.getByRole("link", { name: "Renouveler" }).click();
  await page.getByLabel("Motif").fill("Renouvellement");
  await page.getByLabel(/Je m'engage/).check();
  await page.getByRole("button", { name: "Envoyer la demande" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toHaveText("Une demande de hausse du budget de cette clé est en cours : attendez qu'elle soit traitée ou annulez-la.");

  await page.goto("/cles");
  await carte.getByText("Révoquer cette clé").click();
  await carte.getByRole("button", { name: "Confirmer la révocation" }).click();
  await expect(page.getByRole("status")).toHaveText("Clé révoquée.");

  await page.goto("/demandes");
  await expect(page.getByRole("row", { name: /Hausse de budget.*Annulée/ })).toBeVisible();
  const admin = await (await connecter(browser, ADMIN)).newPage();
  await admin.goto("/gestion/demandes");
  await expect(ligneDeLaFile(admin, "À approuver", salarie).filter({ hasText: "Hausse de budget" })).toHaveCount(0);
});

test("un responsable ne voit pas la hausse de sa propre clé ; un autre responsable la relève, avec l'avertissement de budget d'équipe", async ({ browser }) => {
  const responsable = personne("responsable");
  const autre = personne("autre");
  const pageResponsable = await (await connecter(browser, responsable)).newPage();
  const pageAutre = await (await connecter(browser, autre)).newPage();
  const admin = await (await connecter(browser, ADMIN)).newPage();
  const equipe = `Équipe hausse ${suffixe}`;
  await nouvelleEquipe(admin, equipe);
  await designer(admin, responsable.uid);
  await designer(admin, autre.uid);
  const budget = admin.getByRole("region", { name: "Budget d'équipe" });
  await budget.getByLabel("Budget (€)").fill("10");
  await budget.getByLabel("Période du budget (ex. 30d)").fill("30d");
  await budget.getByRole("button", { name: "Enregistrer le budget" }).click();
  await expect(admin.getByRole("status")).toHaveText("Budget de l'équipe enregistré.");

  await demanderEtApprouver(browser, pageResponsable, responsable, { equipe, projet: "Hausse responsable" });
  const cle = await retirerCle(pageResponsable);
  const carte = pageResponsable.getByRole("region", { name: "Clés émises" }).getByRole("article");
  await demanderHausse(pageResponsable, carte, "20", "Besoin ponctuel");

  await pageResponsable.goto("/gestion/demandes");
  await expect(pageResponsable.getByRole("heading", { level: 1 })).toHaveText("Demandes en attente de validation");
  await expect(pageResponsable.getByRole("row", { name: /Hausse de budget/ })).toHaveCount(0);

  await expect.poll(async () => (await courrielsSujet(responsable.uid, "hausse de budget")).length, { timeout: 15_000 }).toBeGreaterThan(0);
  const [annonce] = await courrielsSujet(responsable.uid, "hausse de budget");
  expect(annonce.to).toContain(autre.email);
  expect(annonce.to).not.toContain(responsable.email);

  await pageAutre.goto("/gestion/demandes");
  await ligneDeLaFile(pageAutre, "À traiter", responsable).filter({ hasText: "Hausse de budget" }).getByRole("link", { name: "Examiner" }).click();
  await expect(pageAutre.getByText("Le montant demandé dépasse le budget de l'équipe (10,00 €).")).toBeVisible();
  await expect(pageAutre.getByLabel("Nouveau budget (€)")).toHaveValue("20");
  await pageAutre.getByRole("button", { name: "Relever le budget" }).click();
  await expect(pageAutre.getByRole("status")).toHaveText("Budget relevé.");
  expect((await infoCle(cle)).maxBudget).toBe(20);

  await admin.goto("/gestion/demandes");
  await expect(ligneDeLaFile(admin, "À approuver", responsable).filter({ hasText: "Hausse de budget" })).toHaveCount(0);
});
