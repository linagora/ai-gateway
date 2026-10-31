import { expect, type Page, test } from "@playwright/test";
import { ADMIN, connecter } from "./outils";

/* En-tête (ticket #180) : une seule ligne à 1 280 px ; le nom, la langue et la déconnexion dans le menu du compte. */
const suffixe = Date.now().toString(36);
const COLLABORATEUR = { uid: `en-tete-${suffixe}`, email: `en-tete-${suffixe}@example.org`, name: `Personne en-tête ${suffixe}` };

/** Nombre de lignes de l'en-tête : ses liens et boutons visibles sur une même ligne ont le même centre, à 4 px près. */
async function lignesDeLEnTete(page: Page): Promise<number> {
  const centres = await page
    .locator("header")
    .locator("a, button")
    .evaluateAll((elements) => elements.map((e) => e.getBoundingClientRect()).filter((r) => r.height > 0).map((r) => (r.top + r.bottom) / 2));
  return centres.filter((centre, i) => centres.slice(0, i).every((autre) => Math.abs(autre - centre) > 4)).length;
}

for (const [qui, personne, gestion] of [
  ["un collaborateur", COLLABORATEUR, null],
  ["un admin", ADMIN, /^(Gestion|Administration)/],
] as const) {
  for (const langue of ["fr-FR", "en-US"]) {
    test(`à 1 280 px, l'en-tête tient sur une ligne pour ${qui} (${langue})`, async ({ browser }) => {
      const context = await connecter(browser, personne, langue);
      const page = await context.newPage();
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto("/catalogue");
      await expect(page.getByRole("button", { name: /^(Mon compte|My account)/ })).toBeVisible();
      if (gestion) await expect(page.getByRole("banner").getByRole("link", { name: gestion })).toBeVisible();
      expect(await lignesDeLEnTete(page)).toBe(1);
      await context.close();
    });
  }
}

test("le menu du compte donne le nom, le choix de la langue et la déconnexion", async ({ browser }) => {
  const context = await connecter(browser, COLLABORATEUR, "fr-FR");
  const page = await context.newPage();
  await page.goto("/catalogue");
  await page.getByRole("button", { name: `Mon compte : ${COLLABORATEUR.name}` }).click();
  const menu = page.getByRole("dialog", { name: COLLABORATEUR.name });
  await expect(menu.getByRole("group", { name: "Langue" })).toBeVisible();
  await menu.getByRole("button", { name: "English" }).click();
  await expect(page.getByRole("navigation").getByRole("link", { name: "Catalog" })).toBeVisible();
  // La page se met à jour sans se recharger : le menu reste ouvert, dans la nouvelle langue, et Échap le ferme.
  await expect(menu.getByRole("button", { name: "Sign out" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();

  await page.getByRole("button", { name: `My account: ${COLLABORATEUR.name}` }).click();
  await menu.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("button", { name: /LemonLDAP/ })).toBeVisible();
  await context.close();
});
