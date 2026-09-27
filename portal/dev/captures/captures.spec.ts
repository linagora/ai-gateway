import { generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { ajouterAEquipe, connecter, type Personne, retirerCle } from "../../e2e/outils";

/*
 * Captures d'écran du README, prises dans l'interface anglaise du portail de dev, avec des personnages fictifs : le
 * scénario décrit les modèles de démonstration, fait approuver et retirer une clé, laisse une demande en attente, active
 * une intégration fictive, puis photographie les pages. À lancer après dev/purger-donnees-de-test.py --appliquer, pour
 * des listes sans données de test, avec un serveur de dev lancé ainsi :
 *
 *   PORTAL_ADMIN_UIDS=mmaudet,amorgan PUBLIC_API_BASE_URL=https://ai-api.linagora.com/v1 npm run dev
 *
 * (l'admin fictif « amorgan » et l'adresse publique de l'API, montrée aux collaborateurs).
 */
const DOSSIER = join(__dirname, "..", "..", "..", "docs", "screenshots");
const ADRESSE_API = "https://ai-api.linagora.com/v1";
const SAM: Personne = { uid: "sdurand", email: "sdurand@example.org", name: "Sam Durand" };
const LEA: Personne = { uid: "lchen", email: "lchen@example.org", name: "Lea Chen" };
const ALEX: Personne = { uid: "amorgan", email: "amorgan@example.org", name: "Alex Morgan" };

/** Modèles de démonstration du LiteLLM de dev : noms français repris des parcours, et textes anglais. */
const MODELES = [
  { nom: "dev-public", niveau: "N1", fr: "Modèle public", en: "Public model", courte: "General-purpose model for public data.", longue: "Fast and inexpensive model for writing, translation and analysis of public information." },
  { nom: "dev-interne", niveau: "N2", fr: "Modèle interne", en: "Internal model", courte: "European model for internal documents.", longue: "Model hosted in the European Union, suited to internal meeting notes, reports and summaries." },
  { nom: "dev-confidentiel", niveau: "N3", fr: "Modèle confidentiel", en: "Confidential model", courte: "Sovereign model for confidential data.", longue: "Model served by a sovereign host, for confidential documents that must never leave the European Union." },
  { nom: "dev-experimental", niveau: "EXP", fr: "Modèle expérimental", en: "Experimental model", courte: "Beta model, public data only.", longue: "Model under evaluation, available in dedicated keys and with public data only." },
  { nom: "dev-image", niveau: "N1", fr: "Modèle graphique", en: "Image model", courte: "Image generation from public briefs.", longue: "Generates illustrations and diagrams from a text description, for public content only." },
] as const;

/**
 * Intégration fictive, rangée avant l'intégration « demo » : déclarée au premier lancement (une intégration ne se
 * supprime pas), active le temps des captures. Adresses des plages réservées à la documentation (RFC 5737).
 */
const OUTIL = { id: "crew-planner", nom: "Crew planner", perimetres: ["Lecture", "Demandes"], adresses: ["203.0.113.10", "198.51.100.0/28"], plafond: "60" };

/** L'admin décrit un modèle en français et en anglais, avec son niveau, et le rend visible. */
async function decrire(admin: Page, modele: (typeof MODELES)[number]): Promise<void> {
  await admin.goto("/gestion/catalogue");
  const fiche = admin.locator("section").filter({ has: admin.locator("code", { hasText: new RegExp(`^${modele.nom}$`) }) });
  await fiche.getByLabel("Nom affiché (français)").fill(modele.fr);
  await fiche.getByLabel("Nom affiché (anglais)").fill(modele.en);
  await fiche.getByLabel("Description courte (français)").fill(`Modèle de démonstration ${modele.niveau}`);
  await fiche.getByLabel("Description courte (anglais)").fill(modele.courte);
  await fiche.getByLabel("Description longue (français)").fill(`Modèle de démonstration ${modele.niveau}, à réponses simulées.`);
  await fiche.getByLabel("Description longue (anglais)").fill(modele.longue);
  await fiche.getByLabel("Niveau maximal").selectOption(modele.niveau);
  await fiche.getByLabel("Visible des collaborateurs").check();
  await fiche.getByRole("button", { name: "Enregistrer" }).click();
  await expect(admin.getByRole("status")).toHaveText("Catalogue mis à jour.");
}

/** Le collaborateur remplit une demande de clé (interface française, contenu anglais) ; `envoyer` la dépose. */
async function remplirDemande(page: Page, demande: { niveau: RegExp; modele: RegExp; motif: string; projet: string }, envoyer = true): Promise<void> {
  await page.goto("/demandes/nouvelle");
  await page.getByLabel("Équipe").selectOption({ label: "R&D" });
  await page.getByRole("radio", { name: demande.niveau }).check();
  await page.getByLabel(demande.modele).check();
  await page.getByLabel("Motif").fill(demande.motif);
  await page.getByLabel("Projet ou affaire").fill(demande.projet);
  await page.getByLabel("Durée souhaitée").selectOption({ label: "3 mois" });
  await page.getByLabel(/Je m'engage/).check();
  if (envoyer) {
    await page.getByRole("button", { name: "Envoyer la demande" }).click();
    await expect(page.getByRole("status")).toHaveText("Demande envoyée aux administrateurs.");
  }
}

/** Déclare l'intégration fictive si elle n'existe pas encore, avec une clé publique, puis l'active ou la désactive. */
async function basculerOutil(admin: Page, action: "Activer" | "Désactiver"): Promise<void> {
  await admin.goto(`/gestion/integrations?integration=${OUTIL.id}`);
  const fiche = admin.getByRole("region", { name: OUTIL.nom });
  if ((await fiche.count()) === 0) {
    const declaration = admin.getByRole("form", { name: "Déclarer une intégration" });
    await declaration.getByLabel("Identifiant").fill(OUTIL.id);
    await declaration.getByLabel("Nom").fill(OUTIL.nom);
    for (const perimetre of OUTIL.perimetres) await declaration.getByRole("checkbox", { name: new RegExp(`^${perimetre}`) }).check();
    await declaration.getByLabel("Adresses IP et plages CIDR").fill(OUTIL.adresses.join("\n"));
    await declaration.getByLabel("Plafond (requêtes par minute)").fill(OUTIL.plafond);
    await declaration.getByRole("button", { name: "Déclarer l'intégration" }).click();
    await expect(admin.getByRole("status")).toHaveText(/^Intégration déclarée/);
    const cle = fiche.getByRole("form", { name: `Ajouter une clé publique ${OUTIL.nom}` });
    await cle.getByLabel("Identifiant de clé (kid)").fill(`${OUTIL.id}-2026`);
    await cle.getByLabel("Clé publique (PEM)").fill(generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString());
    await cle.getByRole("button", { name: "Ajouter la clé" }).click();
    await expect(admin.getByRole("status")).toHaveText("Clé publique ajoutée.");
  }
  const bouton = fiche.getByRole("button", { name: action, exact: true });
  if ((await bouton.count()) > 0) {
    await bouton.click();
    await expect(admin.getByRole("status")).toHaveText(action === "Activer" ? "Intégration activée." : "Intégration désactivée : ses appels sont refusés.");
  }
}

/** Photographie la page, sans le bouton des outils de développement de Next.js. */
async function capturer(page: Page, nom: string): Promise<void> {
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(DOSSIER, `${nom}.png`) });
}

test("captures d'écran du README", async ({ browser }) => {
  const admin = await (await connecter(browser, ALEX)).newPage();
  await admin.goto("/gestion/demandes");
  await expect(admin.getByRole("heading", { level: 1 }), "le serveur de dev doit compter amorgan parmi PORTAL_ADMIN_UIDS").toHaveText("Demandes en attente de validation");

  // Données : modèles décrits, clé de Sam approuvée et retirée, demande de Lea en attente, intégration fictive active.
  for (const modele of MODELES) await decrire(admin, modele);
  const sam = await (await connecter(browser, SAM)).newPage();
  await ajouterAEquipe(SAM.uid, "R&D");
  await remplirDemande(sam, { niveau: /^N2 Interne/, modele: /Modèle interne/, motif: "Summaries of internal meeting notes", projet: "Weekly team report" });
  await admin.goto("/gestion/demandes");
  await admin.getByRole("row", { name: new RegExp(`${SAM.uid}.*Clé d'API`) }).getByRole("link", { name: "Examiner" }).click();
  await admin.getByLabel("Budget (€)").fill("20");
  await admin.getByLabel("Période du budget (ex. 30d)").fill("30d");
  await admin.getByLabel("Durée de validité").selectOption({ label: "3 mois" });
  await admin.getByRole("button", { name: "Approuver", exact: true }).click();
  await expect(admin.getByRole("status")).toHaveText("Demande approuvée.");
  await retirerCle(sam);
  const lea = await (await connecter(browser, LEA)).newPage();
  await ajouterAEquipe(LEA.uid, "R&D");
  await remplirDemande(lea, { niveau: /^N1 Public/, modele: /Modèle public/, motif: "Translate the product documentation into English", projet: "Product documentation" });
  await basculerOutil(admin, "Activer");

  // Captures, dans l'interface anglaise.
  const samEn = await (await connecter(browser, SAM, "en-US")).newPage();
  await samEn.goto("/catalogue");
  await capturer(samEn, "catalog");
  await samEn.goto("/demandes/nouvelle");
  await samEn.getByLabel("Team").selectOption({ label: "R&D" });
  await samEn.getByRole("radio", { name: /^N2 Internal/ }).check();
  await samEn.getByLabel(/Internal model/).check();
  await samEn.getByLabel("Reason").fill("Summaries of internal meeting notes");
  await capturer(samEn, "key-request");
  await samEn.goto("/cles");
  await expect(samEn.getByText(ADRESSE_API, { exact: true }), "le serveur de dev doit montrer l'adresse publique de l'API (PUBLIC_API_BASE_URL)").toBeVisible();
  await capturer(samEn, "my-keys");
  await samEn.goto("/documentation/api");
  await expect(samEn.locator('[data-path="/key-requests"]').first()).toBeVisible();
  await capturer(samEn, "api-docs");

  const adminEn = await (await connecter(browser, ALEX, "en-US")).newPage();
  await adminEn.goto("/gestion/demandes");
  await capturer(adminEn, "approval-queue");
  await adminEn.getByRole("row", { name: new RegExp(LEA.uid) }).getByRole("link", { name: "Review" }).click();
  await expect(adminEn.getByRole("heading", { level: 1 })).toHaveText(`API key for ${LEA.uid}`);
  await capturer(adminEn, "request-review");
  await adminEn.goto("/gestion/integrations");
  await expect(adminEn.locator('section[aria-labelledby="actives"] details').first()).toContainText(OUTIL.nom);
  await capturer(adminEn, "integrations");

  await basculerOutil(admin, "Désactiver");
});
