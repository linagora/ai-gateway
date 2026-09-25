import { expect, type Page, test } from "@playwright/test";
import { ADMIN, ajouterAEquipe, connecter, enrichirModele } from "./outils";

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
  // Le salarié existe dans LiteLLM après sa première connexion ; il rejoint l'équipe R&D de démonstration.
  await (await connecter(browser, salarie)).close();
  await ajouterAEquipe(salarie.uid, "R&D");
});

test("le catalogue montre l'éditeur et la zone d'exécution, jamais le fournisseur « openai » (ticket #3)", async ({ browser }) => {
  const context = await connecter(browser, salarie);
  const page = await context.newPage();
  await page.goto("/catalogue/n1");
  await expect(page.getByRole("article", { name: "Modèle interne" })).toContainText("Mistral AI · UE");
  await expect(page.getByRole("article", { name: "Modèle public" })).toContainText("Moonshot AI · Hors UE");
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

test.describe("vue d'ensemble des niveaux (ticket #5)", () => {
  const carte = (page: Page, nom: string) => page.getByRole("region", { name: nom });

  test("les quatre niveaux s'affichent en français et en anglais", async ({ browser }) => {
    const context = await connecter(browser, salarie);
    const page = await context.newPage();
    await page.goto("/catalogue");
    for (const nom of ["N1 — Public", "N2 — Interne", "N3 — Confidentiel", "Expérimental (bêta)"]) {
      await expect(carte(page, nom)).toContainText("Vous pouvez y confier");
      await expect(carte(page, nom)).toContainText("Jamais");
    }
    await context.close();
    const anglais = await connecter(browser, salarie, "en-US");
    const pageEn = await anglais.newPage();
    await pageEn.goto("/catalogue");
    for (const nom of ["N1 — Public", "N2 — Internal", "N3 — Confidential", "Experimental (beta)"]) {
      await expect(carte(pageEn, nom)).toContainText("You may entrust");
    }
    await anglais.close();
  });

  test("chaque carte donne le nombre de modèles du niveau et son prix de départ", async ({ browser }) => {
    const context = await connecter(browser, salarie);
    const page = await context.newPage();
    await page.goto("/catalogue");
    // Données de démonstration : prix mixtes 0,175 € (public, expérimental), 0,30 € (interne), 0,975 € (confidentiel).
    await expect(carte(page, "N1 — Public")).toContainText(/3 modèles.*à partir de 0,175\s€/);
    await expect(carte(page, "N2 — Interne")).toContainText(/2 modèles.*à partir de 0,30\s€/);
    await expect(carte(page, "N3 — Confidentiel")).toContainText(/1 modèle.*à partir de 0,975\s€/);
    await expect(carte(page, "Expérimental (bêta)")).toContainText(/1 modèle.*à partir de 0,175\s€/);
    await context.close();
  });

  test("« Demander une clé de ce niveau » préremplit le niveau, « Voir les modèles » ouvre la page du niveau", async ({ browser }) => {
    const context = await connecter(browser, salarie);
    const page = await context.newPage();
    await page.goto("/catalogue");
    await carte(page, "N2 — Interne").getByRole("link", { name: "Demander une clé de ce niveau" }).click();
    await expect(page.getByRole("radio", { name: /^N2 — Interne/ })).toBeChecked();
    await page.goto("/catalogue");
    await carte(page, "N3 — Confidentiel").getByRole("link", { name: "Voir les modèles" }).click();
    await expect(page).toHaveURL(/\/catalogue\/n3$/);
    await context.close();
  });

  test("un niveau sans modèle visible affiche un message qui indique à qui s'adresser, sur sa carte et sur sa page (tickets #5 et #7)", async ({ browser }) => {
    const admin = await connecter(browser, ADMIN);
    const pageAdmin = await admin.newPage();
    await pageAdmin.goto("/gestion/catalogue");
    const fiche = pageAdmin.locator("section").filter({ has: pageAdmin.locator("code", { hasText: /^dev-experimental$/ }) });
    await fiche.getByLabel("Visible des salariés").uncheck();
    await fiche.getByRole("button", { name: "Enregistrer" }).click();
    await expect(pageAdmin.getByRole("status")).toHaveText("Catalogue mis à jour.");
    const context = await connecter(browser, salarie);
    const page = await context.newPage();
    await page.goto("/catalogue");
    await expect(carte(page, "Expérimental (bêta)")).toContainText("Aucun modèle n'est encore ouvert à ce niveau");
    await page.goto("/catalogue/experimental");
    await expect(page.getByRole("main")).toContainText("Aucun modèle n'est encore ouvert à ce niveau. Pour en demander un, écrivez aux administrateurs du portail.");
    await enrichirModele(pageAdmin, { nom: "dev-experimental", nomAffiche: "Modèle expérimental", niveau: "EXP" });
    await Promise.all([admin.close(), context.close()]);
  });
});

test.describe("page d'un niveau (ticket #7)", () => {
  const modele = (page: Page, nom: string | RegExp) => page.getByRole("article", { name: nom });

  test("depuis la vue d'ensemble, la page N2 montre les modèles N2 et N3, ces derniers avec le badge « Accepte jusqu'à N3 »", async ({ browser }) => {
    const context = await connecter(browser, salarie);
    const page = await context.newPage();
    await page.goto("/catalogue");
    await page.getByRole("region", { name: "N2 — Interne" }).getByRole("link", { name: "Voir les modèles" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("N2 — Interne");
    await expect(modele(page, "Modèle interne")).toContainText("Mistral AI · UE");
    await expect(modele(page, "Modèle interne")).not.toContainText("Accepte jusqu'à");
    await expect(modele(page, "Modèle confidentiel")).toContainText("Accepte jusqu'à N3");
    await expect(page.getByRole("article")).toHaveCount(2);
    await context.close();
  });

  test("la page Expérimental ne montre que le modèle expérimental", async ({ browser }) => {
    const context = await connecter(browser, salarie);
    const page = await context.newPage();
    await page.goto("/catalogue/experimental");
    await expect(modele(page, "Modèle expérimental")).toBeVisible();
    await expect(page.getByRole("article")).toHaveCount(1);
    await context.close();
  });

  test("une carte donne les capacités, le repère de prix, les prix exacts et le contexte en pages, en français et en anglais", async ({ browser }) => {
    const context = await connecter(browser, salarie);
    const page = await context.newPage();
    await page.goto("/catalogue/n3");
    // Modèle confidentiel de démonstration : 0,40 € en entrée, 2,70 € en sortie, soit un prix mixte de 0,975 € (€€).
    const carte = modele(page, "Modèle confidentiel");
    await expect(carte).toContainText("Images");
    await expect(carte).toContainText("Raisonnement");
    await expect(carte).toContainText(/€€\s*·\s*0,40\s€ en entrée, 2,70\s€ en sortie/);
    await expect(carte).toContainText(/262\s000 jetons, soit environ 350 pages/);
    await expect(carte.getByTitle(/environ 750 jetons/)).toBeVisible();
    await context.close();

    const anglais = await connecter(browser, salarie, "en-US");
    const pageEn = await anglais.newPage();
    await pageEn.goto("/catalogue/n3");
    const carteEn = modele(pageEn, /Modèle confidentiel|Confidential model/);
    await expect(carteEn).toContainText(/€€\s*·\s*€0\.40 input, €2\.70 output/);
    await expect(carteEn).toContainText("262,000 tokens, or about 350 pages");
    await anglais.close();
  });

  test("en anglais, un modèle que l'admin n'a pas traduit s'affiche avec ses textes français", async ({ browser }) => {
    const context = await connecter(browser, salarie, "en-US");
    const page = await context.newPage();
    await page.goto("/catalogue/n2");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("N2 — Internal");
    await expect(modele(page, "Modèle interne")).toContainText("Modèle de démonstration N2");
    await expect(modele(page, /Modèle confidentiel|Confidential model/)).toContainText("Accepts up to N3");
    await context.close();
  });

  test("sur un écran étroit, les cartes s'empilent", async ({ browser }) => {
    const context = await connecter(browser, salarie);
    const page = await context.newPage();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/catalogue/n1");
    const cadres = await Promise.all((await page.getByRole("article").all()).map((carte) => carte.boundingBox()));
    expect(cadres.length).toBeGreaterThan(1);
    for (const [precedent, suivant] of cadres.slice(1).map((cadre, i) => [cadres[i]!, cadre!])) {
      expect(suivant.x).toBe(precedent.x);
      expect(suivant.y).toBeGreaterThanOrEqual(precedent.y + precedent.height);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await context.close();
  });
});
