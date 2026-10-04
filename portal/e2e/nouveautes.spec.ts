import { expect, type Page, test } from "@playwright/test";
import { ADMIN, connecter } from "./outils";

/*
 * Cloche des nouveautés (spécification #124). Les nouveautés sont communes à tous les collaborateurs : chaque parcours
 * donne aux siennes un titre unique, terminé par le suffixe de test que purge le script du dev, et vérifie la pastille
 * par différence.
 */
const suffixe = Date.now().toString(36);
const collaborateur = { uid: `nouveautes-${suffixe}`, email: `nouveautes-${suffixe}@example.org`, name: `Collaborateur ${suffixe}` };
const anglophone = { uid: `nouveautes-en-${suffixe}`, email: `nouveautes-en-${suffixe}@example.org`, name: `Employee ${suffixe}` };

const cloche = (page: Page) => page.getByRole("banner").getByRole("button", { name: /^Nouveautés/ });
const panneau = (page: Page) => page.getByRole("dialog", { name: "Nouveautés non lues" });

/** Nombre de nouveautés non lues qu'annonce la cloche par son nom accessible (0 sans pastille), une fois l'en-tête arrivé. */
async function nonLues(page: Page): Promise<number> {
  await expect(cloche(page)).toBeVisible();
  const nombre = /\((\d+) nouveautés? non lues?\)/.exec(await cloche(page).ariaSnapshot());
  return nombre ? Number(nombre[1]) : 0;
}

/** Textes d'une nouveauté rédigée par les parcours ; l'anglais est facultatif. */
interface Redaction {
  categorie?: string;
  resume?: string;
  texte?: string;
  anglais?: { titre: string; resume: string; texte: string };
}

/** Rédige une nouveauté depuis la gestion, la prévisualise, puis la publie (session admin). */
async function publier(page: Page, titre: string, redaction: Redaction = {}): Promise<void> {
  const {
    categorie = "Service",
    resume = "Une coupure de quelques minutes, dimanche matin.",
    texte = "La passerelle sera coupée dimanche de 8 h à 8 h 15.\nAucune action n'est attendue.",
    anglais,
  } = redaction;
  await page.goto("/gestion/nouveautes");
  const formulaire = page.getByRole("form", { name: "Rédiger une nouveauté" });
  await formulaire.getByLabel("Catégorie").selectOption({ label: categorie });
  await formulaire.getByLabel("Titre (français)").fill(titre);
  await formulaire.getByLabel("Résumé (français)").fill(resume);
  await formulaire.getByLabel("Texte (français)").fill(texte);
  if (anglais) {
    await formulaire.getByLabel("Titre (anglais)").fill(anglais.titre);
    await formulaire.getByLabel("Résumé (anglais)").fill(anglais.resume);
    await formulaire.getByLabel("Texte (anglais)").fill(anglais.texte);
  }
  await formulaire.getByRole("button", { name: "Enregistrer le brouillon" }).click();
  await expect(page.getByRole("status")).toHaveText("Brouillon enregistré.");
  await expect(page.getByRole("row", { name: new RegExp(titre) })).toContainText("Brouillon");
  // Aperçu : la page du brouillon, marquée comme telle, sans « J'ai lu ».
  await page.getByRole("link", { name: `Aperçu de « ${titre} »` }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(titre);
  await expect(page.getByRole("main")).toContainText("Brouillon : aperçu réservé aux admins");
  await expect(page.getByRole("button", { name: "J'ai lu" })).toHaveCount(0);
  await page.goto("/gestion/nouveautes");
  await page.getByRole("button", { name: `Publier « ${titre} »` }).click();
  await expect(page.getByRole("status")).toHaveText("Nouveauté publiée.");
  await expect(page.getByRole("row", { name: new RegExp(titre) })).toContainText("Publiée le");
}

/** Supprime une nouveauté depuis la gestion, après confirmation (session admin) : les parcours ne laissent rien derrière eux. */
async function supprimer(page: Page, titre: string): Promise<void> {
  await page.goto("/gestion/nouveautes");
  const ligne = page.getByRole("row", { name: new RegExp(titre) });
  await ligne.getByText("Supprimer", { exact: true }).click();
  await ligne.getByRole("button", { name: "Confirmer la suppression" }).click();
  await expect(page.getByRole("status")).toHaveText("Nouveauté supprimée.");
  await expect(page.getByRole("row", { name: new RegExp(titre) })).toHaveCount(0);
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
  await supprimer(admin, titre);
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
  await supprimer(admin, titre);
});

test("en anglais, la cloche, le panneau et la page d'une nouveauté traduite sont en anglais (ticket #133)", async ({ browser }) => {
  const titre = `Nouveau prix de Qwen3.8 ${suffixe}`;
  const titreEn = `New Qwen3.8 pricing ${suffixe}`;
  const admin = await (await connecter(browser, ADMIN)).newPage();
  await publier(admin, titre, {
    categorie: "Prix",
    resume: "Le prix de Qwen3.8 baisse.",
    texte: "Nouveau prix : 0,30 €.",
    anglais: { titre: titreEn, resume: "Qwen3.8 gets cheaper.", texte: "New price: €0.30." },
  });

  const lecteur = await (await connecter(browser, anglophone, "en-US")).newPage();
  await lecteur.goto("/");
  const clocheEn = lecteur.getByRole("banner").getByRole("button", { name: /^What's new/ });
  await clocheEn.click();
  const panneauEn = lecteur.getByRole("dialog", { name: "Unread news" });
  await expect(panneauEn).toContainText("Qwen3.8 gets cheaper.");
  await panneauEn.getByRole("link", { name: titreEn }).click();
  await expect(lecteur.getByRole("heading", { level: 1 })).toHaveText(titreEn);
  await expect(lecteur.getByRole("main")).toContainText("New price: €0.30.");
  await expect(lecteur.getByRole("main")).toContainText("Pricing");
  await lecteur.getByRole("button", { name: "I've read it" }).click();
  await expect(lecteur.getByRole("status")).toHaveText("Marked as read.");
  await expect(lecteur.getByRole("main")).toContainText("Read on");
  await supprimer(admin, titre);
});

