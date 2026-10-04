import { expect, type Page, test } from "@playwright/test";
import { ADMIN, connecter } from "./outils";

/*
 * Cloche des nouveautés (spécification #124). Les nouveautés sont communes à tous les collaborateurs : chaque parcours
 * donne aux siennes un titre unique, terminé par le suffixe de test que purge le script du dev, et vérifie la pastille
 * par différence.
 */
const suffixe = Date.now().toString(36);
const collaborateur = { uid: `nouveautes-${suffixe}`, email: `nouveautes-${suffixe}@example.org`, name: `Collaborateur ${suffixe}` };

const cloche = (page: Page) => page.getByRole("banner").getByRole("button", { name: /^Nouveautés/ });
const panneau = (page: Page) => page.getByRole("dialog", { name: "Nouveautés non lues" });

/** Nombre de nouveautés non lues que montre la pastille de la cloche (0 sans pastille), une fois l'en-tête arrivé. */
async function nonLues(page: Page): Promise<number> {
  await expect(cloche(page)).toBeVisible();
  const pastille = cloche(page).locator('span[aria-hidden="true"]');
  return (await pastille.count()) === 0 ? 0 : Number(await pastille.textContent());
}

/** Rédige une nouveauté depuis la gestion et la publie (session admin). */
async function publier(page: Page, titre: string): Promise<void> {
  await page.goto("/gestion/nouveautes");
  const formulaire = page.getByRole("form", { name: "Rédiger une nouveauté" });
  await formulaire.getByLabel("Catégorie").selectOption({ label: "Service" });
  await formulaire.getByLabel("Titre (français)").fill(titre);
  await formulaire.getByLabel("Résumé (français)").fill("Une coupure de quelques minutes, dimanche matin.");
  await formulaire.getByLabel("Texte (français)").fill("La passerelle sera coupée dimanche de 8 h à 8 h 15.\nAucune action n'est attendue.");
  await formulaire.getByRole("button", { name: "Enregistrer le brouillon" }).click();
  await expect(page.getByRole("status")).toHaveText("Brouillon enregistré.");
  await expect(page.getByRole("row", { name: new RegExp(titre) })).toContainText("Brouillon");
  await page.getByRole("button", { name: `Publier « ${titre} »` }).click();
  await expect(page.getByRole("status")).toHaveText("Nouveauté publiée.");
  await expect(page.getByRole("row", { name: new RegExp(titre) })).toContainText("Publiée le");
}

test("un admin publie une nouveauté ; un collaborateur la voit signalée par la cloche, l'ouvre et l'acquitte (ticket #130)", async ({ browser }) => {
  const titre = `Maintenance de la passerelle ${suffixe}`;
  const lecteur = await (await connecter(browser, collaborateur)).newPage();
  await lecteur.goto("/");
  const avant = await nonLues(lecteur);

  const admin = await (await connecter(browser, ADMIN)).newPage();
  await publier(admin, titre);

  await lecteur.reload();
  expect(await nonLues(lecteur)).toBe(avant + 1);
  await cloche(lecteur).click();
  await expect(panneau(lecteur)).toBeVisible();
  await expect(panneau(lecteur)).toContainText("Une coupure de quelques minutes, dimanche matin.");
  await lecteur.keyboard.press("Escape");
  await expect(panneau(lecteur)).toBeHidden();

  await cloche(lecteur).click();
  await panneau(lecteur).getByRole("link", { name: titre }).click();
  await expect(lecteur.getByRole("heading", { level: 1 })).toHaveText(titre);
  await expect(lecteur.getByRole("main")).toContainText("Aucune action n'est attendue.");
  await lecteur.getByRole("button", { name: "J'ai lu" }).click();
  await expect(lecteur.getByRole("status")).toHaveText("Lecture enregistrée.");
  await expect(lecteur.getByRole("main")).toContainText("Lue le");
  expect(await nonLues(lecteur)).toBe(avant);
  await cloche(lecteur).click();
  await expect(panneau(lecteur).getByRole("link", { name: titre })).toHaveCount(0);
});

test("l'archive, ouverte depuis le panneau, montre une nouveauté non lue, puis lue une fois acquittée (ticket #131)", async ({ browser }) => {
  const titre = `Nouveau modèle au catalogue ${suffixe}`;
  const admin = await (await connecter(browser, ADMIN)).newPage();
  await publier(admin, titre);

  const lecteur = await (await connecter(browser, collaborateur)).newPage();
  await lecteur.goto("/");
  await cloche(lecteur).click();
  await panneau(lecteur).getByRole("link", { name: "Toutes les nouveautés" }).click();
  await expect(lecteur.getByRole("heading", { level: 1 })).toHaveText("Toutes les nouveautés");
  const entree = lecteur.getByRole("listitem").filter({ has: lecteur.getByRole("link", { name: titre }) });
  await expect(entree).toContainText("Non lue");

  await entree.getByRole("link", { name: titre }).click();
  await lecteur.getByRole("button", { name: "J'ai lu" }).click();
  await expect(lecteur.getByRole("status")).toHaveText("Lecture enregistrée.");
  await lecteur.getByRole("link", { name: "Toutes les nouveautés" }).click();
  await expect(entree).toContainText("Lue le");
  await expect(entree).not.toContainText("Non lue");
});
