import { expect, type Page, test } from "@playwright/test";
import { connecter, enrichirModele } from "./outils";

/*
 * Parcours principal (PRD §9, critères 4, 5 et 6 jusqu'à l'approbation) : un admin (PORTAL_ADMIN_UIDS=mmaudet
 * dans .env) et un salarié créé pour l'occasion, qui fait tout le parcours en français, puis en anglais.
 */
const suffix = Date.now().toString(36);
const admin = { uid: "mmaudet", email: "mmaudet@linagora.com", name: "Admin E2E" };

/** Textes attendus par le salarié, dans chaque langue. Les modèles de démonstration n'ont que des textes français. */
const LANGUES = [
  {
    code: "fr",
    navigateur: "fr-FR",
    equipe: "Équipe",
    motif: "Motif",
    envoyer: "Envoyer la demande",
    engagement: /Je m'engage/,
    adhesionEnvoyee: "Demande d'adhésion envoyée.",
    demandeEnvoyee: "Demande envoyée aux administrateurs.",
    voirModeles: "Voir les modèles",
    niveaux: { N2: "N2 — Interne", N3: "N3 — Confidentiel", EXP: "Expérimental (bêta)" },
    niveauRefuse: "Les modèles acceptent le niveau de confidentialité déclaré (dev-interne)",
    cle: "Clé d'API",
    soumise: "Soumise",
    approuvee: "Approuvée",
    date: /\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}/,
  },
  {
    code: "en",
    navigateur: "en-US",
    equipe: "Team",
    motif: "Reason",
    envoyer: "Send request",
    engagement: /I commit/,
    adhesionEnvoyee: "Membership request sent.",
    demandeEnvoyee: "Request sent to the administrators.",
    voirModeles: "See the models",
    niveaux: { N2: "N2 — Internal", N3: "N3 — Confidential", EXP: "Experimental (beta)" },
    niveauRefuse: "The models accept the declared confidentiality level (dev-interne)",
    cle: "API key",
    soumise: "Submitted",
    approuvee: "Approved",
    date: /\d{1,2}\/\d{1,2}\/\d{2}, \d{1,2}:\d{2}\s[AP]M/,
  },
];

const echapper = (texte: string) => texte.replace(/[()]/g, "\\$&");

test.describe.configure({ mode: "serial" });

let adminPage: Page;

test.beforeAll(async ({ browser }) => {
  adminPage = await (await connecter(browser, admin)).newPage();
});

test("un admin enrichit le catalogue et fixe les valeurs par défaut", async () => {
  for (const [nom, nomAffiche, niveau] of [
    ["dev-public", "Modèle public", "N1"],
    ["dev-interne", "Modèle interne", "N2"],
    ["dev-confidentiel", "Modèle confidentiel", "N3"],
    ["dev-experimental", "Modèle expérimental", "EXP"],
  ]) {
    await enrichirModele(adminPage, { nom, nomAffiche, niveau });
  }
  await adminPage.goto("/gestion/parametres");
  await adminPage.getByLabel("Budget par défaut (€)").fill("10");
  await adminPage.getByLabel("Période du budget (ex. 30d)").fill("30d");
  await adminPage.getByLabel("Durée de validité par défaut (jours)").fill("30");
  await adminPage.getByRole("button", { name: "Enregistrer" }).click();
  await expect(adminPage.getByRole("status")).toHaveText("Paramètres enregistrés.");
});

for (const T of LANGUES) {
  test.describe(`parcours du salarié (${T.code})`, () => {
    const salarie = { uid: `e2e-${T.code}-${suffix}`, email: `e2e-${T.code}-${suffix}@example.org`, name: `Salarié ${T.code} ${suffix}` };
    let salariePage: Page;

    test.beforeAll(async ({ browser }) => {
      salariePage = await (await connecter(browser, salarie, T.navigateur)).newPage();
    });

    test("un salarié demande à rejoindre l'équipe R&D et un admin l'y ajoute (F-22)", async () => {
      await salariePage.goto("/demandes/adhesion");
      await salariePage.getByLabel(T.equipe).selectOption({ label: "R&D" });
      await salariePage.getByLabel(T.motif).fill("Rejoindre le projet de démonstration");
      await salariePage.getByRole("button", { name: T.envoyer }).click();
      await expect(salariePage.getByRole("status")).toHaveText(T.adhesionEnvoyee);

      await adminPage.goto("/gestion/demandes");
      await adminPage.getByRole("row", { name: new RegExp(`${salarie.uid}.*Adhésion`) }).getByRole("link", { name: "Examiner" }).click();
      await adminPage.getByRole("button", { name: /Approuver : ajouter/ }).click();
      await expect(adminPage.getByRole("status")).toHaveText("Adhésion approuvée : le demandeur a été ajouté à l'équipe.");
    });

    test("critère 4 : le salarié voit le catalogue et soumet une demande N2", async () => {
      await salariePage.goto("/catalogue");
      await salariePage.getByRole("region", { name: T.niveaux.N2 }).getByRole("link", { name: T.voirModeles }).click();
      await expect(salariePage.getByRole("article", { name: "Modèle interne" })).toBeVisible();

      await salariePage.goto("/demandes/nouvelle");
      await salariePage.getByLabel(T.equipe).selectOption({ label: "R&D" });
      await salariePage.getByRole("radio", { name: new RegExp(`^${T.niveaux.N2}`) }).check();
      await salariePage.getByLabel(/Modèle interne/).check();
      await salariePage.getByLabel(T.motif).fill("Rédaction de comptes rendus internes");
      await salariePage.getByLabel(T.engagement).check();
      await salariePage.getByRole("button", { name: T.envoyer }).click();
      await expect(salariePage.getByRole("status")).toHaveText(T.demandeEnvoyee);
      await expect(salariePage.getByRole("row", { name: new RegExp(`${T.cle}.*R&D.*${T.niveaux.N2}.*dev-interne.*${T.soumise}`) })).toBeVisible();
    });

    test("critère 5 : une demande N3 incluant un modèle N2 est refusée côté serveur", async () => {
      await salariePage.goto("/demandes/nouvelle");
      await salariePage.getByLabel(T.equipe).selectOption({ label: "R&D" });
      await salariePage.getByRole("radio", { name: new RegExp(`^${T.niveaux.N3}`) }).check();
      await salariePage.getByLabel(/Modèle interne/).check();
      await salariePage.getByLabel(T.motif).fill("Analyse de contrats");
      await salariePage.getByLabel(T.engagement).check();
      await salariePage.getByRole("button", { name: T.envoyer }).click();
      await expect(salariePage.getByRole("main").getByRole("alert")).toContainText(T.niveauRefuse);
    });

    test("un admin approuve la demande N2 et le salarié la voit approuvée", async () => {
      await adminPage.goto("/gestion/demandes");
      await adminPage.getByRole("row", { name: new RegExp(`${salarie.uid}.*Clé d'API`) }).getByRole("link", { name: "Examiner" }).click();
      await expect(adminPage.getByText("✘")).toHaveCount(0);
      await adminPage.getByRole("button", { name: "Approuver", exact: true }).click();
      await expect(adminPage.getByRole("status")).toHaveText("Demande approuvée.");

      await salariePage.goto("/demandes");
      const ligne = salariePage.getByRole("row", { name: new RegExp(`${T.cle}.*R&D.*${T.approuvee}`) });
      await expect(ligne).toBeVisible();
      await expect(ligne.getByRole("cell").first()).toHaveText(T.date);
    });

    test("un salarié demande une clé Expérimental pour essayer un modèle en bêta", async () => {
      await salariePage.goto("/catalogue");
      await salariePage.getByRole("region", { name: T.niveaux.EXP }).getByRole("link", { name: T.voirModeles }).click();
      await expect(salariePage.getByRole("heading", { level: 1 })).toHaveText(T.niveaux.EXP);
      await expect(salariePage.getByRole("article", { name: "Modèle expérimental" })).toBeVisible();
      await expect(salariePage.getByRole("article", { name: "Modèle interne" })).toHaveCount(0);

      await salariePage.goto("/demandes/nouvelle");
      await salariePage.getByLabel(T.equipe).selectOption({ label: "R&D" });
      await salariePage.getByRole("radio", { name: new RegExp(`^${echapper(T.niveaux.EXP)}`) }).check();
      await salariePage.getByLabel(/Modèle expérimental/).check();
      await salariePage.getByLabel(T.motif).fill("Essai du nouveau modèle sur de la documentation publique");
      await salariePage.getByLabel(T.engagement).check();
      await salariePage.getByRole("button", { name: T.envoyer }).click();
      await expect(salariePage.getByRole("status")).toHaveText(T.demandeEnvoyee);
      await expect(
        salariePage.getByRole("row", { name: new RegExp(`${T.cle}.*R&D.*${echapper(T.niveaux.EXP)}.*dev-experimental.*${T.soumise}`) }),
      ).toBeVisible();
    });
  });
}
