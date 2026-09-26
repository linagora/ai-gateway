import { expect, type Page, test } from "@playwright/test";
import { ADMIN, connecter } from "./outils";

/* Abonnements individuels aux offres des fournisseurs d'IA (spécification #51). */
const suffixe = Date.now().toString(36);
const personne = (n: string) => ({ uid: `abonnements-${n}-${suffixe}`, email: `abonnements-${n}-${suffixe}@example.org`, name: `Personne ${n} ${suffixe}` });

/** Champs d'une offre saisis par un admin. */
interface Offre {
  fournisseur: string;
  nom: string;
  prix: string;
  niveau: string;
  reglesFr: string;
  reglesEn?: string;
  lien?: string;
}

/** Un admin crée une offre visible depuis la gestion du catalogue. */
async function creerOffre(admin: Page, offre: Offre): Promise<void> {
  await admin.goto("/gestion/catalogue");
  const formulaire = admin.getByRole("region", { name: "Offres d'abonnement" }).getByRole("form", { name: "Nouvelle offre" });
  await formulaire.getByLabel("Fournisseur").fill(offre.fournisseur);
  await formulaire.getByLabel("Nom de l'offre").fill(offre.nom);
  await formulaire.getByLabel("Prix mensuel TTC (€)").fill(offre.prix);
  await formulaire.getByLabel("Niveau maximal").selectOption({ label: offre.niveau });
  await formulaire.getByLabel("Règles d'usage (français)").fill(offre.reglesFr);
  if (offre.reglesEn) await formulaire.getByLabel("Règles d'usage (anglais)").fill(offre.reglesEn);
  if (offre.lien) await formulaire.getByLabel("Lien vers l'offre (https)").fill(offre.lien);
  await formulaire.getByRole("button", { name: "Créer l'offre" }).click();
  await expect(admin.getByRole("status")).toHaveText("Offre enregistrée.");
}

/** Un admin masque une offre depuis la gestion du catalogue : elle n'est plus proposée, sans être supprimée. */
async function masquerOffre(admin: Page, fournisseur: string, nom: string): Promise<void> {
  await admin.goto("/gestion/catalogue");
  const formulaire = admin.getByRole("form", { name: `${fournisseur} · ${nom}` });
  await formulaire.getByLabel("Visible au catalogue").uncheck();
  await formulaire.getByRole("button", { name: "Enregistrer l'offre" }).click();
  await expect(admin.getByRole("status")).toHaveText("Offre enregistrée.");
}

test("un admin crée une offre, que les salariés voient au catalogue en français et en anglais ; masquée, elle disparaît (ticket #53)", async ({ browser }) => {
  const admin = await (await connecter(browser, ADMIN)).newPage();
  const nom = `Claude Max essai ${suffixe}`;
  await creerOffre(admin, {
    fournisseur: "Anthropic",
    nom,
    prix: "108",
    niveau: "N1 Public",
    reglesFr: "Désactivez l'entraînement sur vos données dans les paramètres de confidentialité.",
    reglesEn: "Turn off training on your data in the privacy settings.",
    lien: "https://claude.com/pricing",
  });

  // Le catalogue mène aux abonnements, à part des niveaux.
  const salarie = await (await connecter(browser, personne("catalogue"))).newPage();
  await salarie.goto("/catalogue");
  await salarie.getByRole("region", { name: "Abonnements" }).getByRole("link", { name: "Voir les offres" }).click();
  await expect(salarie.getByRole("heading", { level: 1 })).toHaveText("Abonnements");
  const carte = salarie.getByRole("article", { name: nom });
  await expect(carte).toContainText("Anthropic");
  await expect(carte).toContainText(/108,00\s€ TTC par mois/);
  await expect(carte).toContainText(/Niveau maximal des données\s*:\s*N1 Public/);
  await expect(carte.getByRole("img", { name: /Classification NC/ })).toBeVisible();
  await expect(carte.getByRole("img", { name: /Classification C1/ })).toBeVisible();
  await expect(carte).toContainText("Désactivez l'entraînement sur vos données dans les paramètres de confidentialité.");
  await expect(carte.getByRole("link", { name: "Voir l'offre chez Anthropic" })).toHaveAttribute("href", "https://claude.com/pricing");

  // En anglais, les règles de l'offre et les libellés suivent la langue du salarié.
  const anglais = await (await connecter(browser, personne("anglais"), "en-US")).newPage();
  await anglais.goto("/catalogue/abonnements");
  await expect(anglais.getByRole("heading", { level: 1 })).toHaveText("Subscriptions");
  const card = anglais.getByRole("article", { name: nom });
  await expect(card).toContainText(/€108\.00 incl\. VAT per month/);
  await expect(card).toContainText("Maximum data level: N1 Public");
  await expect(card).toContainText("Turn off training on your data in the privacy settings.");

  // Masquée, l'offre n'est plus proposée.
  await masquerOffre(admin, "Anthropic", nom);
  await expect(admin.getByRole("heading", { name: new RegExp(`Anthropic · ${nom}.*masquée`) })).toBeVisible();
  await salarie.reload();
  await expect(salarie.getByRole("article", { name: nom })).toHaveCount(0);
});
