import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { ADMIN, ajouterMembre, approuverDemande, connecter, creerOffre, declarer, demanderOffre, echapper, faireSortir, masquerOffre, nouvelleEquipe, supprimerEquipe } from "./outils";

/* Remboursements (retours de l'utilisateur du 2026-09-26) : les prélèvements à rembourser, transmis à la comptabilité avec leur fichier CSV. */
const suffixe = Date.now().toString(36);
const personne = (n: string) => ({ uid: `remboursements-${n}-${suffixe}`, email: `remboursements-${n}-${suffixe}@example.org`, name: `Personne ${n} ${suffixe}` });
// Mois (AAAA-MM) du prélèvement d'un abonnement déclaré aujourd'hui.
const moisCourant = new Date().toISOString().slice(0, 7);

test("un admin transmet à la comptabilité les prélèvements du mois : ils sortent de la liste, et la transmission fournit son fichier CSV", async ({ browser }) => {
  const membre = personne("titulaire");
  const pageMembre = await (await connecter(browser, membre)).newPage();
  const admin = await (await connecter(browser, ADMIN)).newPage();
  const equipe = `Équipe remboursements ${suffixe}`;
  const offre = `Offre remboursements ${suffixe}`;
  await creerOffre(admin, { fournisseur: "Anthropic", nom: offre, prix: "21.60", niveau: "N1 Public", reglesFr: "Usage professionnel seulement." });
  await nouvelleEquipe(admin, equipe);
  await ajouterMembre(admin, membre.uid);
  const pageEquipe = admin.url();
  await demanderOffre(pageMembre, offre, equipe);
  await approuverDemande(admin, membre);
  await declarer(pageMembre, offre, { montant: "21.60", adresse: membre.email });

  // L'onglet « Remboursements » montre, pour le mois choisi, le prélèvement du jour et le total du collaborateur.
  await admin.goto("/gestion/remboursements");
  await admin.getByLabel("Mois").fill(moisCourant);
  await admin.getByRole("button", { name: "Afficher" }).click();
  const groupe = admin.getByRole("rowgroup", { name: membre.name });
  await expect(groupe).toContainText(`Anthropic · ${offre}`);
  await expect(groupe).toContainText(equipe);
  await expect(groupe.getByRole("row").last()).toContainText("21,60");

  // Marquée comme transmise, la liste ne le montre plus ; la transmission ouvre l'historique, avec son fichier CSV.
  await admin.getByText("Marquer comme transmis à la comptabilité").click();
  await admin.getByRole("button", { name: "Confirmer la transmission" }).click();
  await expect(admin.getByRole("status")).toHaveText("Prélèvements transmis : téléchargez le fichier CSV de la transmission pour la comptabilité.");
  await expect(admin.getByRole("rowgroup", { name: membre.name })).toHaveCount(0);
  const transmission = admin.getByRole("region", { name: "Transmissions à la comptabilité" }).getByRole("row").nth(1);
  const [telechargement] = await Promise.all([admin.waitForEvent("download"), transmission.getByRole("link", { name: /CSV/ }).click()]);
  expect(telechargement.suggestedFilename()).toMatch(new RegExp(`^remboursements-${moisCourant}-transmis-le-\\d{4}-\\d{2}-\\d{2}\\.csv$`));
  const contenu = await readFile(await telechargement.path(), "utf8");
  expect(contenu).toContain(`${membre.name};${membre.uid};${membre.email};Anthropic · ${offre};${equipe};`);
  expect(contenu).toMatch(new RegExp(`${echapper(membre.uid)};.*;21,60\\r\\n`));

  // Nettoyage : résiliation déclarée, sortie du membre, suppression de l'équipe, offre masquée.
  await admin.goto(`/gestion/collaborateurs/${membre.uid}`);
  const ligne = admin.getByRole("region", { name: "Abonnements" }).getByRole("row", { name: new RegExp(echapper(offre)) });
  await ligne.getByText("Déclarer la résiliation", { exact: true }).click();
  await ligne.getByRole("button", { name: "Déclarer la résiliation à sa place" }).click();
  await expect(admin.getByRole("status")).toHaveText("Résiliation déclarée.");
  await admin.goto(pageEquipe);
  await faireSortir(admin, membre.uid);
  await supprimerEquipe(admin);
  await expect(admin.getByRole("status")).toHaveText("Équipe supprimée.");
  await masquerOffre(admin, "Anthropic", offre);
});
