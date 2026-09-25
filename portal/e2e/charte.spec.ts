import { createHash } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { ADMIN, ajouterAEquipe, connecter } from "./outils";

/* Charte Linagora légère (ticket #4). */
const suffixe = Date.now().toString(36);
const personne = { uid: `charte-${suffixe}`, email: `charte-${suffixe}@example.org`, name: `Personne ${suffixe}` };

/** Rouge du logo Linagora de référence (Wikimedia Commons) : #C51C42. */
const ROUGE_LINAGORA = "rgb(197, 28, 66)";

/** Rapport de contraste WCAG d'une couleur #rrggbb sur fond blanc. */
function contrasteSurBlanc(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 1.05 / (0.2126 * r + 0.7152 * g + 0.0722 * b + 0.05);
}

const rgb = (hex: string) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ")})`;

test("le logo et la couleur principale de Linagora figurent dans l'en-tête et sur les boutons principaux, en français et en anglais", async ({ browser }) => {
  for (const [langue, bouton] of [
    ["fr-FR", "Envoyer la demande"],
    ["en-US", "Send request"],
  ]) {
    const context = await connecter(browser, personne, langue);
    const page = await context.newPage();
    await page.goto("/demandes/adhesion");
    await expect(page.getByRole("banner").getByRole("img", { name: "Linagora" })).toBeVisible();
    await expect(page.getByRole("banner")).toHaveCSS("border-top-color", ROUGE_LINAGORA);
    await expect(page.getByRole("button", { name: bouton })).toHaveCSS("background-color", ROUGE_LINAGORA);
    await context.close();
  }
});

test("les quatre couleurs de niveau sont définies une seule fois, lisibles sur fond blanc, et toujours accompagnées du nom du niveau", async ({ browser }) => {
  const context = await connecter(browser, personne);
  const page = await context.newPage();
  await page.goto("/catalogue");
  const couleurs = await page.evaluate(() =>
    ["n1", "n2", "n3", "exp"].map((n) => getComputedStyle(document.documentElement).getPropertyValue(`--niveau-${n}`).trim().toLowerCase()),
  );
  expect(couleurs.every((c) => /^#[0-9a-f]{6}$/.test(c))).toBe(true);
  expect(new Set(couleurs).size).toBe(4);
  for (const couleur of couleurs) expect(contrasteSurBlanc(couleur)).toBeGreaterThanOrEqual(4.5);
  for (const [i, nom] of ["N1 Public", "N2 Interne", "N3 Confidentiel", "Expérimental (bêta)"].entries()) {
    await expect(page.getByRole("region", { name: nom })).toHaveCSS("border-left-color", rgb(couleurs[i]));
  }
  await page.goto("/catalogue/n3");
  await expect(page.getByRole("main").locator("header")).toHaveCSS("border-left-color", rgb(couleurs[2]));
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("N3 Confidentiel");
  await context.close();
});

/** Lignes du texte visible de la page (titre compris) qui contiennent un tiret quadratin. */
async function lignesAvecTiretQuadratin(page: Page): Promise<string[]> {
  const texte = await page.evaluate(() => [document.title, document.body.innerText].join("\n"));
  return texte.split("\n").filter((ligne) => ligne.includes("—"));
}

test("aucune page n'affiche de tiret quadratin, même quand une valeur manque", async ({ browser }) => {
  // Une demande de clé sans projet ni budget, et une demande d'accès à une équipe, sans niveau ni modèles.
  const redacteur = { uid: `tirets-${suffixe}`, email: `tirets-${suffixe}@example.org`, name: `Rédacteur ${suffixe}` };
  await ajouterAEquipe(redacteur.uid, "R&D");
  const page = await (await connecter(browser, redacteur)).newPage();
  await page.goto("/demandes/nouvelle");
  await page.getByLabel("Équipe").selectOption({ label: "R&D" });
  await page.getByRole("radio", { name: /^N1 Public/ }).check();
  await page.getByLabel(/Modèle public/).check();
  await page.getByLabel("Motif").fill("Contrôle typographique");
  await page.getByLabel(/Je m'engage/).check();
  await page.getByRole("button", { name: "Envoyer la demande" }).click();
  await expect(page.getByRole("status")).toHaveText("Demande envoyée aux administrateurs.");
  await page.goto("/demandes/adhesion");
  await page.getByLabel("Équipe").selectOption({ label: "LPS Paris" });
  await page.getByLabel("Motif").fill("Contrôle typographique");
  await page.getByRole("button", { name: "Envoyer la demande" }).click();
  await expect(page.getByRole("status")).toHaveText("Demande d'accès envoyée.");

  const admin = await (await connecter(browser, ADMIN)).newPage();
  for (const [onglet, chemin] of [
    [page, "/catalogue"],
    [page, "/catalogue/n1"],
    [page, "/catalogue/n1?modele=dev-public"],
    [page, "/demandes/nouvelle"],
    [page, "/demandes"],
    [page, "/cles"],
    [admin, "/gestion/demandes"],
    [admin, "/gestion/cles"],
    [admin, "/gestion/catalogue"],
    [admin, "/gestion/parametres"],
  ] as const) {
    await onglet.goto(chemin);
    expect(await lignesAvecTiretQuadratin(onglet), chemin).toEqual([]);
  }
  for (const type of ["Clé d'API", "Accès à une équipe"]) {
    await admin.goto("/gestion/demandes");
    await admin.getByRole("row", { name: new RegExp(`${redacteur.uid}.*${type}`) }).getByRole("link", { name: "Examiner" }).click();
    await expect(admin.getByRole("heading", { level: 1 })).toHaveText(`${type} pour ${redacteur.uid}`);
    expect(await lignesAvecTiretQuadratin(admin), type).toEqual([]);
  }
});

test("l'onglet affiche l'icône de linagora.ai, y compris avant la connexion", async ({ page, request }) => {
  await page.goto("/connexion");
  await expect(page.locator('link[rel="icon"]').first()).toHaveAttribute("href", /\/favicon\.ico/);
  const icone = await request.get("/favicon.ico");
  expect(icone.status()).toBe(200);
  // Empreinte de l'icône publiée par https://linagora.ai/favicon.ico, relevée le 2026-09-25.
  expect(createHash("sha256").update(await icone.body()).digest("hex")).toBe("d9715204ef42e10ce2bff91ff9ce2f76cfa612eccb88fdd89f3316b781c91457");
});
