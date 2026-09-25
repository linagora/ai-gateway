import { expect, test } from "@playwright/test";
import { connecter } from "./outils";

/* Charte Linagora légère (ticket #4). */
const suffixe = Date.now().toString(36);
const personne = { uid: `charte-${suffixe}`, email: `charte-${suffixe}@example.org`, name: `Personne ${suffixe}` };

/** Rouge du logo Linagora. */
const ROUGE_LINAGORA = "rgb(197, 24, 67)";

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
    ["fr-FR", "Filtrer"],
    ["en-US", "Filter"],
  ]) {
    const context = await connecter(browser, personne, langue);
    const page = await context.newPage();
    await page.goto("/catalogue/n1");
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
  for (const [i, nom] of ["N1 — Public", "N2 — Interne", "N3 — Confidentiel", "Expérimental (bêta)"].entries()) {
    await expect(page.getByRole("region", { name: nom })).toHaveCSS("border-left-color", rgb(couleurs[i]));
  }
  await page.goto("/catalogue/n3");
  await expect(page.getByRole("main").locator("header")).toHaveCSS("border-left-color", rgb(couleurs[2]));
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("N3 — Confidentiel");
  await context.close();
});
