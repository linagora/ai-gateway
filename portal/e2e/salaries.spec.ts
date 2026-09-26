import { expect, test } from "@playwright/test";
import {
  ADMIN,
  ajouterMembre,
  approuverDemande,
  connecter,
  creerOffre,
  declarer,
  demanderEtApprouver,
  demanderOffre,
  echapper,
  enrichirModele,
  faireSortir,
  masquerOffre,
  nouvelleEquipe,
  retirerCle,
  supprimerEquipe,
} from "./outils";

/* Fiche d'un salarié (retours de l'utilisateur du 2026-09-26) : ses équipes, ses clés et ses abonnements en cours, et les actions de la gestion. */
const suffixe = Date.now().toString(36);
const personne = (n: string) => ({ uid: `salaries-${n}-${suffixe}`, email: `salaries-${n}-${suffixe}@example.org`, name: `Personne ${n} ${suffixe}` });

test.beforeAll(async ({ browser }) => {
  const context = await connecter(browser, ADMIN);
  await enrichirModele(await context.newPage(), { nom: "dev-public", nomAffiche: "Modèle public", niveau: "N1" });
  await context.close();
});

test("depuis la page de son équipe, la fiche d'un salarié montre sa clé et son abonnement ; les actions faites depuis la fiche y ramènent", async ({ browser }) => {
  const membre = personne("fiche");
  const pageMembre = await (await connecter(browser, membre)).newPage();
  const admin = await (await connecter(browser, ADMIN)).newPage();
  const equipe = `Équipe fiche ${suffixe}`;
  const offre = `Offre fiche ${suffixe}`;
  await creerOffre(admin, { fournisseur: "Anthropic", nom: offre, prix: "21.60", niveau: "N1 Public", reglesFr: "Usage professionnel seulement." });
  await nouvelleEquipe(admin, equipe);
  await ajouterMembre(admin, membre.uid);
  const pageEquipe = admin.url();
  // Une clé émise et un abonnement déclaré, dans l'équipe.
  await demanderEtApprouver(browser, pageMembre, membre, { equipe, projet: "Fiche" });
  await retirerCle(pageMembre);
  await demanderOffre(pageMembre, offre, equipe);
  await approuverDemande(admin, membre);
  await declarer(pageMembre, offre, { montant: "21.60", adresse: membre.email });

  // L'uid du membre, sur la page de l'équipe, mène à sa fiche.
  await admin.goto(pageEquipe);
  await admin.getByRole("region", { name: "Membres" }).getByRole("link", { name: membre.uid, exact: true }).click();
  await expect(admin.getByRole("heading", { level: 1 })).toHaveText(membre.uid);
  await expect(admin.getByRole("region", { name: "Équipes" }).getByRole("link", { name: equipe, exact: true })).toBeVisible();
  const cles = admin.getByRole("region", { name: "Clés d'API" });
  const abonnements = admin.getByRole("region", { name: "Abonnements" });
  const ligneCle = cles.getByRole("row", { name: new RegExp(echapper(equipe)) });
  const ligneAbonnement = abonnements.getByRole("row", { name: new RegExp(echapper(offre)) });
  await expect(ligneCle).toContainText("Clé émise");
  await expect(ligneAbonnement).toContainText("Actif");

  // Demande de résiliation, révocation, puis déclaration de la résiliation : chacune ramène à la fiche.
  const fiche = new RegExp(`/gestion/salaries/${echapper(membre.uid)}\\?ok=`);
  await ligneAbonnement.getByText("Demander la résiliation").click();
  await ligneAbonnement.getByLabel("Motif").fill("Fin du projet");
  await ligneAbonnement.getByRole("button", { name: "Envoyer la demande de résiliation" }).click();
  await expect(admin.getByRole("status")).toHaveText("Demande de résiliation envoyée au titulaire.");
  await expect(admin).toHaveURL(fiche);
  await expect(ligneAbonnement).toContainText("À résilier");

  await ligneCle.getByText("Révoquer").click();
  await ligneCle.getByRole("button", { name: "Confirmer la révocation" }).click();
  await expect(admin.getByRole("status")).toHaveText("Clé révoquée.");
  await expect(admin).toHaveURL(fiche);
  await expect(cles).toContainText("Aucune clé active.");

  await ligneAbonnement.getByText("Déclarer la résiliation", { exact: true }).click();
  await ligneAbonnement.getByRole("button", { name: "Déclarer la résiliation à sa place" }).click();
  await expect(admin.getByRole("status")).toHaveText("Résiliation déclarée.");
  await expect(admin).toHaveURL(fiche);
  await expect(abonnements).toContainText("Aucun abonnement actif.");

  // Nettoyage : l'équipe, puis l'offre, masquée.
  await admin.goto(pageEquipe);
  await faireSortir(admin, membre.uid);
  await supprimerEquipe(admin);
  await expect(admin.getByRole("status")).toHaveText("Équipe supprimée.");
  await masquerOffre(admin, "Anthropic", offre);
});

test("onglet « Salariés » : le nombre de membres d'une équipe y mène, la recherche retrouve un salarié et son uid exact ouvre sa fiche", async ({ browser }) => {
  const membre = personne("liste");
  await (await connecter(browser, membre)).close();
  const admin = await (await connecter(browser, ADMIN)).newPage();
  const equipe = `Équipe liste ${suffixe}`;
  await nouvelleEquipe(admin, equipe);
  await ajouterMembre(admin, membre.uid);
  const pageEquipe = admin.url();

  // Depuis l'onglet « Équipes », le nombre de membres mène aux salariés de l'équipe.
  await admin.goto("/gestion/equipes");
  await admin.getByRole("row", { name: new RegExp(echapper(equipe)) }).getByRole("link", { name: "Voir le membre de l'équipe" }).click();
  await expect(admin.getByRole("heading", { level: 1 })).toHaveText("Salariés");
  await expect(admin.getByText(`Salariés de l'équipe ${equipe}`)).toBeVisible();
  const liste = admin.getByRole("table");
  await expect(liste.getByRole("row")).toHaveCount(2);
  await expect(liste.getByRole("row", { name: new RegExp(echapper(membre.uid)) })).toContainText(equipe);

  // La recherche retrouve un salarié par une partie de son uid ; son uid exact ouvre sa fiche.
  await admin.getByRole("link", { name: "Tous les salariés" }).click();
  await admin.getByLabel("Rechercher un salarié").fill(membre.uid.slice(0, -3));
  await admin.getByRole("button", { name: "Rechercher" }).click();
  await expect(admin.getByRole("table").getByRole("link", { name: membre.uid, exact: true })).toBeVisible();
  await admin.getByLabel("Rechercher un salarié").fill(membre.uid);
  await admin.getByRole("button", { name: "Rechercher" }).click();
  await expect(admin.getByRole("heading", { level: 1 })).toHaveText(membre.uid);
  await expect(admin.getByRole("navigation", { name: "Administration" }).getByRole("link", { name: "Salariés" })).toHaveAttribute("aria-current", "true");

  // Nettoyage.
  await admin.goto(pageEquipe);
  await faireSortir(admin, membre.uid);
  await supprimerEquipe(admin);
  await expect(admin.getByRole("status")).toHaveText("Équipe supprimée.");
});
