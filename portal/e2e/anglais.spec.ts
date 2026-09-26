import { expect, type Page, test } from "@playwright/test";
import { ADMIN, ajouterAEquipe, connecter, enrichirModele } from "./outils";

/*
 * Ticket #13 : un parcours complet en anglais ne montre aucun texte en français, hors contenus saisis par
 * l'admin (fiches des modèles de démonstration, en français seulement) et identifiants (uid, alias, noms de
 * modèles). Il couvre la connexion, le catalogue, la page d'un niveau, le détail, la sélection, la demande et
 * la validation admin.
 */
const suffixe = Date.now().toString(36);
const salarie = { uid: `anglais-${suffixe}`, email: `anglais-${suffixe}@example.org`, name: `Employee ${suffixe}` };

/**
 * Contenus saisis par l'admin, en français seulement (noms des modèles et des équipes de démonstration, dont celles
 * créées par les parcours des équipes : « Équipe membres <suffixe> »…) ; nom de la langue française dans le
 * sélecteur ; identifiants techniques, en minuscules reliées par des tirets (uid « cles-sans-expiration-… », alias,
 * noms de modèles).
 */
const AUTORISES = [
  /Modèle (public|interne|confidentiel|expérimental)/g,
  /Équipe \p{L}+ [a-z0-9]+/gu,
  /Modèle de démonstration (N1|N2|N3|EXP)(, à réponses simulées\.)?/g,
  /Français/g,
  /(?<!\p{L})[a-z0-9]+(?:-[a-z0-9]+)+(?!\p{L})/gu,
];

/** Lettres et mots propres au français. */
const FRANCAIS =
  /[éèêëàâùûçôîïœ]|(?<!\p{L})(le|la|les|des|du|une|pour|avec|sans|votre|vous|est|sont|aucune?|niveaux?|modèles?|demandes?|équipes?|clés?|données|et|ou|par|dans|aux?|cette?|qui|que|pas|ne|leur)(?!\p{L})/iu;

/** Le texte visible de la page et ses textes d'accessibilité ne contiennent aucun français. */
async function sansFrancais(page: Page, etape: string): Promise<void> {
  const textes = await page.evaluate(() => {
    const attributs = [...document.querySelectorAll("[aria-label], [title], [placeholder], img[alt]")].flatMap((element) =>
      ["aria-label", "title", "placeholder", "alt"].map((nom) => element.getAttribute(nom) ?? ""),
    );
    return [document.title, document.body.innerText, ...attributs].join("\n");
  });
  const reste = AUTORISES.reduce((texte, autorise) => texte.replace(autorise, " "), textes);
  expect(
    reste.split("\n").filter((ligne) => FRANCAIS.test(ligne)),
    `texte français à l'étape « ${etape} »`,
  ).toEqual([]);
}

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

test("un parcours complet en anglais, de la connexion à la validation admin, ne montre aucun texte en français", async ({ browser }) => {
  const context = await browser.newContext({ locale: "en-US" });
  const page = await context.newPage();
  await page.goto("/");
  await expect(page).toHaveURL(/\/connexion/);
  await sansFrancais(page, "connexion");
  await page.getByRole("button", { name: "Sign in with LemonLDAP::NG" }).click();
  await page.locator('input[name="username"]').fill(salarie.uid);
  await page.locator('textarea[name="claims"]').fill(JSON.stringify({ email: salarie.email, name: salarie.name }));
  await page.getByRole("button", { name: "Sign-in" }).click();
  await expect(page.getByRole("heading", { name: `Hello ${salarie.name}` })).toBeVisible();
  await sansFrancais(page, "accueil");
  await ajouterAEquipe(salarie.uid, "R&D");

  await page.getByRole("navigation").getByRole("link", { name: "Catalog" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Model catalog");
  await sansFrancais(page, "catalogue");
  await page.getByRole("region", { name: "N2 Internal" }).getByRole("link", { name: "See the models" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("N2 Internal");
  await sansFrancais(page, "page d'un niveau");
  await page.getByRole("article", { name: "Modèle interne" }).getByRole("link", { name: "Modèle interne", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await sansFrancais(page, "détail");
  await page.getByRole("dialog").getByRole("link", { name: "Close" }).click();

  await page.getByRole("checkbox", { name: "Select Modèle interne" }).check();
  await page.getByRole("checkbox", { name: /^Select (Modèle confidentiel|Confidential model)$/ }).check();
  await page.getByRole("button", { name: /Request a key for the selection/ }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Request an API key");
  await sansFrancais(page, "demande préremplie");
  await page.getByLabel("Team").selectOption({ label: "R&D" });
  await page.getByLabel("Reason").fill("Summaries of internal documents");
  await page.getByLabel(/I commit/).check();
  await page.getByRole("button", { name: "Send request" }).click();
  await expect(page.getByRole("status")).toHaveText("Request sent to the administrators.");
  await sansFrancais(page, "mes demandes");
  await context.close();

  const admin = await (await connecter(browser, ADMIN, "en-US")).newPage();
  await admin.goto("/gestion/demandes");
  await sansFrancais(admin, "file des demandes");
  await admin.getByRole("row", { name: new RegExp(`${salarie.uid}.*API key`) }).getByRole("link", { name: "Review" }).click();
  await expect(admin.getByRole("heading", { level: 1 })).toHaveText(`API key for ${salarie.uid}`);
  await sansFrancais(admin, "fiche de validation");
  await admin.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(admin.getByRole("status")).toHaveText("Request approved.");
  await sansFrancais(admin, "demande approuvée");
  await admin.goto("/gestion/parametres");
  await sansFrancais(admin, "valeurs par défaut");
});

test("une adresse inconnue affiche une page introuvable dans la langue du visiteur", async ({ browser }) => {
  for (const [langue, titre] of [
    ["en-US", "Page not found"],
    ["fr-FR", "Page introuvable"],
  ]) {
    const page = await (await connecter(browser, ADMIN, langue)).newPage();
    const reponse = await page.goto("/catalogue/n4");
    expect(reponse?.status()).toBe(404);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(titre);
    if (langue === "en-US") await sansFrancais(page, "page introuvable");
  }
});
