import { expect, test } from "@playwright/test";
import { connecter } from "./outils";

/* Mise en page : dans les tableaux, les textes et les boutons d'une même ligne sont centrés verticalement. */
const suffixe = Date.now().toString(36);
const personne = (n: string) => ({ uid: `mise-en-page-${n}-${suffixe}`, email: `mise-en-page-${n}-${suffixe}@example.org`, name: `Personne ${n} ${suffixe}` });

test("dans un tableau, le bouton d'une ligne est centré verticalement sur son texte", async ({ browser }) => {
  const page = await (await connecter(browser, personne("salarie"))).newPage();
  await page.goto("/demandes/adhesion");
  await page.getByLabel("Équipe").selectOption({ index: 0 });
  await page.getByLabel("Motif").fill("Essai de mise en page");
  await page.getByRole("button", { name: "Envoyer la demande" }).click();
  await expect(page.getByRole("status")).toHaveText("Demande d'accès envoyée.");

  const ligne = page.getByRole("row").filter({ has: page.getByRole("button", { name: "Annuler" }) });
  const ecart = await ligne.evaluate((tr) => {
    const milieu = (r: DOMRect) => (r.top + r.bottom) / 2;
    const texte = document.createRange();
    texte.selectNodeContents(tr.querySelector("td")!);
    return Math.abs(milieu(tr.querySelector("button")!.getBoundingClientRect()) - milieu(texte.getBoundingClientRect()));
  });
  expect(ecart).toBeLessThanOrEqual(2);
});
