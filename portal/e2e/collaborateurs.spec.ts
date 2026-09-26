import { expect, test } from "@playwright/test";
import {
  ADMIN,
  ajouterMembre,
  approuverDemande,
  connecter,
  creerOffre,
  declarer,
  demandeApprouvee,
  demanderEtApprouver,
  designer,
  demanderOffre,
  echapper,
  enrichirModele,
  faireSortir,
  masquerOffre,
  nouvelleEquipe,
  retirerCle,
  supprimerEquipe,
} from "./outils";

/* Fiche d'un collaborateur (retours de l'utilisateur du 2026-09-26) : ses équipes, ses clés et ses abonnements en cours, et les actions de la gestion. */
const suffixe = Date.now().toString(36);
const personne = (n: string) => ({ uid: `collaborateurs-${n}-${suffixe}`, email: `collaborateurs-${n}-${suffixe}@example.org`, name: `Personne ${n} ${suffixe}` });

test.beforeAll(async ({ browser }) => {
  const context = await connecter(browser, ADMIN);
  await enrichirModele(await context.newPage(), { nom: "dev-public", nomAffiche: "Modèle public", niveau: "N1" });
  await context.close();
});

test("depuis la page de son équipe, la fiche d'un collaborateur montre sa clé et son abonnement ; les actions faites depuis la fiche y ramènent", async ({ browser }) => {
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

  // Dans les onglets de la gestion, l'uid du demandeur ou du titulaire mène à sa fiche.
  for (const [onglet, zone] of [
    ["/gestion/demandes", "Archive : demandes traitées"],
    ["/gestion/cles", "Clés actives"],
    ["/gestion/abonnements", "Abonnements actifs"],
  ] as const) {
    await admin.goto(onglet);
    await admin.getByRole("region", { name: zone }).getByRole("link", { name: membre.uid, exact: true }).first().click();
    await expect(admin.getByRole("heading", { level: 1 })).toHaveText(membre.uid);
  }

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
  const fiche = new RegExp(`/gestion/collaborateurs/${echapper(membre.uid)}\\?ok=`);
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

test("onglet « Collaborateurs » : le nombre de membres d'une équipe y mène, la recherche retrouve un collaborateur et son uid exact ouvre sa fiche", async ({ browser }) => {
  const membre = personne("liste");
  await (await connecter(browser, membre)).close();
  const admin = await (await connecter(browser, ADMIN)).newPage();
  const equipe = `Équipe liste ${suffixe}`;
  await nouvelleEquipe(admin, equipe);
  await ajouterMembre(admin, membre.uid);
  const pageEquipe = admin.url();

  // Depuis l'onglet « Équipes », le nombre de membres mène aux collaborateurs de l'équipe.
  await admin.goto("/gestion/equipes");
  await admin.getByRole("row", { name: new RegExp(echapper(equipe)) }).getByRole("link", { name: "Voir le membre de l'équipe" }).click();
  await expect(admin.getByRole("heading", { level: 1 })).toHaveText("Collaborateurs");
  await expect(admin.getByText(`Collaborateurs de l'équipe ${equipe}`)).toBeVisible();
  const liste = admin.getByRole("table");
  await expect(liste.getByRole("row")).toHaveCount(2);
  await expect(liste.getByRole("row", { name: new RegExp(echapper(membre.uid)) })).toContainText(equipe);

  // La recherche retrouve un collaborateur par une partie de son uid ; son uid exact ouvre sa fiche.
  await admin.getByRole("link", { name: "Tous les collaborateurs" }).click();
  await admin.getByLabel("Rechercher un collaborateur").fill(membre.uid.slice(0, -3));
  await admin.getByRole("button", { name: "Rechercher" }).click();
  await expect(admin.getByRole("table").getByRole("link", { name: membre.uid, exact: true })).toBeVisible();
  await admin.getByLabel("Rechercher un collaborateur").fill(membre.uid);
  await admin.getByRole("button", { name: "Rechercher" }).click();
  await expect(admin.getByRole("heading", { level: 1 })).toHaveText(membre.uid);
  await expect(admin.getByRole("navigation", { name: "Administration" }).getByRole("link", { name: "Collaborateurs" })).toHaveAttribute("aria-current", "true");

  // Nettoyage.
  await admin.goto(pageEquipe);
  await faireSortir(admin, membre.uid);
  await supprimerEquipe(admin);
  await expect(admin.getByRole("status")).toHaveText("Équipe supprimée.");
});

test("un responsable voit, dans l'onglet et sur la fiche, les membres de son équipe limités à celle-ci, et agit sur leurs clés", async ({ browser }) => {
  const responsable = personne("responsable");
  const membre = personne("membre");
  const pageResponsable = await (await connecter(browser, responsable)).newPage();
  const pageMembre = await (await connecter(browser, membre)).newPage();
  const admin = await (await connecter(browser, ADMIN)).newPage();
  const equipe = `Équipe responsable ${suffixe}`;
  await nouvelleEquipe(admin, equipe);
  await designer(admin, responsable.uid);
  await ajouterMembre(admin, membre.uid);
  const pageEquipe = admin.url();
  // Une clé émise dans son équipe ; une clé approuvée dans R&D, hors de l'autorité du responsable.
  await demanderEtApprouver(browser, pageMembre, membre, { equipe, projet: "Responsable" });
  await retirerCle(pageMembre);
  await demandeApprouvee(browser, pageMembre, membre, "Hors équipe");

  // Son onglet « Collaborateurs » liste le membre avec son équipe seule ; la fiche ne montre que ce qui la concerne.
  await pageResponsable.goto("/gestion/collaborateurs");
  const ligneListe = pageResponsable.getByRole("table").getByRole("row", { name: new RegExp(echapper(membre.uid)) });
  await expect(ligneListe).toContainText(equipe);
  await expect(ligneListe).not.toContainText("R&D");
  await ligneListe.getByRole("link", { name: membre.uid, exact: true }).click();
  await expect(pageResponsable.getByRole("heading", { level: 1 })).toHaveText(membre.uid);
  await expect(pageResponsable.getByRole("region", { name: "Équipes" })).not.toContainText("R&D");
  const cles = pageResponsable.getByRole("region", { name: "Clés d'API" });
  const ligneCle = cles.getByRole("row", { name: new RegExp(echapper(equipe)) });
  await expect(ligneCle).toContainText("Clé émise");
  await expect(cles).not.toContainText("R&D");

  // Il bloque puis débloque la clé du membre depuis la fiche.
  await ligneCle.getByRole("button", { name: "Bloquer" }).click();
  await expect(pageResponsable.getByRole("status")).toHaveText("Clé bloquée.");
  await expect(ligneCle).toContainText("bloquée");
  await ligneCle.getByRole("button", { name: "Débloquer" }).click();
  await expect(pageResponsable.getByRole("status")).toHaveText("Clé débloquée.");

  // Un collaborateur hors de ses équipes lui est introuvable.
  await pageResponsable.goto(`/gestion/collaborateurs/${ADMIN.uid}`);
  await expect(pageResponsable.getByRole("heading", { level: 1 })).toHaveText("Page introuvable");

  // Nettoyage.
  await admin.goto(pageEquipe);
  await faireSortir(admin, membre.uid);
  await faireSortir(admin, responsable.uid);
  await supprimerEquipe(admin);
  await expect(admin.getByRole("status")).toHaveText("Équipe supprimée.");
});
