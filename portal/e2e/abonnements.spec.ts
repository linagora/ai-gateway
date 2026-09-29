import { type Browser, expect, type Page, test } from "@playwright/test";
import {
  ADMIN,
  ajouterMembre,
  approuver,
  approuverDemande,
  choisirOffre,
  connecter,
  courriels,
  creerOffre,
  declarer,
  demanderComplement,
  demanderOffre,
  designer,
  donnerAccord,
  echapper,
  examinerDemande,
  ligneDeLaFile,
  faireSortir,
  masquerOffre,
  nouvelleEquipe,
  type Personne,
  refuser,
  supprimerEquipe,
} from "./outils";

/* Abonnements individuels aux offres des fournisseurs d'IA (spécification #51). */
const suffixe = Date.now().toString(36);
const personne = (n: string) => ({ uid: `abonnements-${n}-${suffixe}`, email: `abonnements-${n}-${suffixe}@example.org`, name: `Personne ${n} ${suffixe}` });

/** Situation d'un parcours d'abonnement : l'admin, le responsable et le membre, leur équipe et l'offre. */
interface Situation {
  admin: Page;
  pageResponsable: Page;
  pageMembre: Page;
  responsable: Personne;
  membre: Personne;
  equipe: string;
  pageEquipe: string;
  offre: string;
}

/** Mise en place : une offre visible, et une équipe avec son responsable et son membre. */
async function equipeEtOffre(browser: Browser, nom: string): Promise<Situation> {
  const responsable = personne(`${nom}-responsable`);
  const membre = personne(`${nom}-membre`);
  const pageResponsable = await (await connecter(browser, responsable)).newPage();
  const pageMembre = await (await connecter(browser, membre)).newPage();
  const admin = await (await connecter(browser, ADMIN)).newPage();
  const offre = `Offre ${nom} ${suffixe}`;
  await creerOffre(admin, { fournisseur: "Anthropic", nom: offre, prix: "108", niveau: "N1 Public", reglesFr: "Désactivez l'entraînement sur vos données." });
  const equipe = `Équipe ${nom} ${suffixe}`;
  await nouvelleEquipe(admin, equipe);
  await designer(admin, responsable.uid);
  await ajouterMembre(admin, membre.uid);
  return { admin, pageResponsable, pageMembre, responsable, membre, equipe, pageEquipe: admin.url(), offre };
}

/**
 * Mise en place, puis la demande d'abonnement du membre, pour la durée donnée (trois mois), avec l'accord du
 * responsable, puis approuvée par un admin.
 */
async function abonnementApprouve(browser: Browser, nom: string, duree = "3 mois"): Promise<Situation> {
  const situation = await equipeEtOffre(browser, nom);
  await demanderOffre(situation.pageMembre, situation.offre, situation.equipe, duree);
  await examinerDemande(situation.pageResponsable, situation.membre);
  await donnerAccord(situation.pageResponsable);
  await approuverDemande(situation.admin, situation.membre);
  return situation;
}

/**
 * Un admin déclare, à la place de leurs titulaires, la résiliation des abonnements de l'équipe encore actifs ou à
 * résilier : une équipe ne se supprime pas tant qu'il en reste.
 */
async function resilierAbonnementsDeLEquipe(admin: Page, pageEquipe: string): Promise<void> {
  await admin.goto(`/gestion/abonnements?equipe=${new URL(pageEquipe).pathname.split("/").pop()}`);
  const actifs = admin.getByRole("region", { name: "Abonnements actifs" });
  // Une ligne d'en-tête, puis une ligne par abonnement.
  while ((await actifs.getByRole("row").count()) > 1) {
    const ligne = actifs.getByRole("row").nth(1);
    await ligne.getByText("Déclarer la résiliation", { exact: true }).click();
    await ligne.getByRole("button", { name: "Déclarer la résiliation à sa place" }).click();
    await expect(admin.getByRole("status")).toHaveText("Résiliation déclarée.");
  }
}

/** Nettoyage d'une équipe : sortie des membres donnés (qui annule leurs demandes en cours), résiliation de ses abonnements, suppression. */
async function viderEtSupprimer(admin: Page, pageEquipe: string, uids: string[]): Promise<void> {
  await admin.goto(pageEquipe);
  for (const uid of uids) await faireSortir(admin, uid);
  await resilierAbonnementsDeLEquipe(admin, pageEquipe);
  await admin.goto(pageEquipe);
  await supprimerEquipe(admin);
  await expect(admin.getByRole("status")).toHaveText("Équipe supprimée.");
}

/** Nettoyage d'un parcours : son équipe, puis son offre, masquée. */
async function nettoyer({ admin, pageEquipe, membre, responsable, offre }: Situation): Promise<void> {
  await viderEtSupprimer(admin, pageEquipe, [membre.uid, responsable.uid]);
  await masquerOffre(admin, "Anthropic", offre);
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

  // Le haut du catalogue présente les deux voies, la passerelle d'abord, et mène aux abonnements.
  const salarie = await (await connecter(browser, personne("catalogue"))).newPage();
  await salarie.goto("/catalogue");
  await expect(salarie.getByRole("main")).toContainText("Modèles de la passerelle, la solution privilégiée");
  await expect(salarie.getByRole("main")).toContainText(
    "Abonnement individuel (ChatGPT, Claude, Kimi…) : délivré seulement après un contrôle renforcé et sur justification détaillée ; ce n'est pas la solution que nous privilégions par défaut.",
  );
  await salarie.getByRole("main").getByRole("link", { name: "Voir les offres d'abonnement" }).click();
  await expect(salarie.getByRole("heading", { level: 1 })).toHaveText("Abonnements");
  await expect(salarie.getByRole("main")).toContainText("Un abonnement n'est délivré qu'après un contrôle renforcé et sur justification détaillée");

  // Les offres se présentent par fournisseur : l'offre choisie dans la liste montre son prix, son niveau et ses règles.
  const carte = salarie.getByRole("region", { name: "Anthropic" });
  await expect(carte.getByRole("img")).not.toHaveCount(0);
  await choisirOffre(carte, nom);
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
  const card = anglais.getByRole("region", { name: "Anthropic" });
  await choisirOffre(card, nom);
  await expect(card).toContainText(/€108\.00 incl\. VAT per month/);
  await expect(card).toContainText("Maximum data level: N1 Public");
  await expect(card).toContainText("Turn off training on your data in the privacy settings.");

  // Masquée, l'offre n'est plus proposée.
  await masquerOffre(admin, "Anthropic", nom);
  await expect(admin.getByRole("heading", { name: new RegExp(`Anthropic · ${nom}.*masquée`) })).toBeVisible();
  await salarie.reload();
  await expect(salarie.getByRole("region", { name: "Anthropic" }).getByRole("option", { name: new RegExp(echapper(nom)) })).toHaveCount(0);
});

test("un membre demande une offre pour son équipe ; le responsable donne son accord, un admin l'approuve, et le courriel explique comment souscrire puis déclarer (tickets #54 et #95)", async ({ browser }) => {
  const responsable = personne("responsable");
  const membre = personne("membre");
  const pageResponsable = await (await connecter(browser, responsable)).newPage();
  const pageMembre = await (await connecter(browser, membre)).newPage();
  const admin = await (await connecter(browser, ADMIN)).newPage();
  const nomOffre = `ChatGPT Plus essai ${suffixe}`;
  await creerOffre(admin, {
    fournisseur: "OpenAI",
    nom: nomOffre,
    prix: "23",
    niveau: "N1 Public",
    reglesFr: "Désactivez « Améliorer le modèle pour tous » dans les paramètres.",
    reglesEn: "Turn off “Improve the model for everyone” in the settings.",
  });
  const equipe = `Équipe abonnements ${suffixe}`;
  await nouvelleEquipe(admin, equipe);
  await designer(admin, responsable.uid);
  await ajouterMembre(admin, membre.uid);
  const pageEquipe = admin.url();

  // Le membre demande l'offre depuis le catalogue, pour son équipe, en voyant qui validera.
  await pageMembre.goto("/catalogue/abonnements");
  const openai = pageMembre.getByRole("region", { name: "OpenAI" });
  await choisirOffre(openai, nomOffre);
  await openai.getByRole("button", { name: "Demander cet abonnement" }).click();
  await expect(pageMembre.getByRole("heading", { level: 1 })).toHaveText("Demander un abonnement");
  await expect(pageMembre.getByRole("region", { name: new RegExp(`Offre demandée.*${echapper(nomOffre)}`) })).toContainText(/23,00\s€ TTC par mois/);
  await pageMembre.getByLabel("Équipe").selectOption({ label: equipe });
  await expect(pageMembre.getByText(`Votre demande recevra d'abord l'accord de : ${responsable.uid}, puis l'approbation d'un administrateur.`)).toBeVisible();
  await pageMembre.getByLabel("Motif").fill("Rédaction assistée des comptes rendus");
  await pageMembre.getByLabel("Durée souhaitée").selectOption({ label: "6 mois" });
  await pageMembre.getByLabel(/Je m'engage à ne confier à cet abonnement/).check();
  await pageMembre.getByRole("button", { name: "Envoyer la demande" }).click();
  await expect(pageMembre.getByRole("status")).toHaveText("Demande envoyée.");
  await expect(pageMembre.getByRole("row", { name: new RegExp(`Abonnement.*${echapper(equipe)}.*OpenAI · ${echapper(nomOffre)}.*Soumise`) })).toBeVisible();

  // Le responsable l'examine : il ne l'approuve pas, il donne son accord, avec un commentaire pour les admins.
  await examinerDemande(pageResponsable, membre);
  await expect(pageResponsable.getByRole("main")).toContainText(`${nomOffre} (OpenAI)`);
  await expect(pageResponsable.getByRole("button", { name: "Approuver", exact: true })).toHaveCount(0);
  await expect(pageResponsable.getByLabel("Durée de validité")).toHaveCount(0);
  await donnerAccord(pageResponsable, "Comptes rendus de toute l'équipe");

  // Le membre voit l'accord du responsable, en attente de l'approbation d'un admin.
  await pageMembre.goto("/demandes");
  await expect(pageMembre.getByRole("row", { name: new RegExp(`Abonnement.*${echapper(equipe)}.*Accord du responsable`) })).toContainText(
    "En attente de l'approbation d'un administrateur",
  );

  // Les admins reçoivent la demande à approuver, avec le commentaire et le lien vers sa fiche.
  const aApprouver = `[AI GATEWAY] Demande d'abonnement à approuver : ${membre.name} / Subscription request to approve: ${membre.name}`;
  await expect.poll(async () => (await courriels(membre.uid)).map((c) => c.subject), { timeout: 15_000 }).toContain(aApprouver);
  const courrielAdmins = (await courriels(membre.uid)).find((c) => c.subject === aApprouver)?.text ?? "";
  expect(courrielAdmins).toContain(`${responsable.name} (${responsable.uid}) a donné son accord à la demande d'abonnement de ${membre.name} (${membre.email}) :`);
  expect(courrielAdmins).toContain("Commentaire du responsable : Comptes rendus de toute l'équipe");
  expect(courrielAdmins).toMatch(/\/gestion\/demandes\/\S+/);

  // L'admin la retrouve dans sa file, voit l'accord, et l'approuve pour la durée demandée, six mois.
  await examinerDemande(admin, membre);
  await expect(admin.getByRole("main")).toContainText("Accord du responsable");
  await expect(admin.getByRole("main")).toContainText(responsable.uid);
  await expect(admin.getByRole("main")).toContainText("Comptes rendus de toute l'équipe");
  await expect(admin.getByLabel("Durée de validité")).toHaveValue("180");
  await approuver(admin);

  // Le membre apprend comment souscrire puis déclarer l'abonnement.
  const sujet = "[AI GATEWAY] Votre demande d'abonnement est approuvée / Your subscription request is approved";
  await expect.poll(async () => (await courriels(membre.uid)).map((c) => c.subject), { timeout: 15_000 }).toContain(sujet);
  const approbation = (await courriels(membre.uid)).find((c) => c.subject === sujet)?.text ?? "";
  expect(approbation).toContain("Souscrivez-le vous-même chez OpenAI, de préférence avec votre adresse professionnelle");
  expect(approbation).toContain("Règles d'usage : Désactivez « Améliorer le modèle pour tous » dans les paramètres.");
  expect(approbation).toContain("Déclarez ensuite l'abonnement dans « Mes abonnements » avant le");
  await pageMembre.goto("/demandes");
  await expect(pageMembre.getByRole("row", { name: new RegExp(`Abonnement.*${echapper(equipe)}.*Approuvée`) })).toBeVisible();

  // Nettoyage : la sortie du membre annule sa demande approuvée non déclarée ; l'équipe se supprime ; l'offre est masquée.
  await admin.goto(pageEquipe);
  await faireSortir(admin, membre.uid);
  await faireSortir(admin, responsable.uid);
  await supprimerEquipe(admin);
  await expect(admin.getByRole("status")).toHaveText("Équipe supprimée.");
  await masquerOffre(admin, "OpenAI", nomOffre);
});

test("le titulaire déclare l'abonnement approuvé, qui apparaît dans « Mes abonnements » ; la fiche d'une nouvelle demande le montre (ticket #55)", async ({ browser }) => {
  const situation = await abonnementApprouve(browser, "declaration");
  const { pageMembre, pageResponsable, membre, equipe, offre } = situation;

  // La pastille du menu signale l'abonnement à déclarer, et « Mes abonnements » propose la déclaration.
  await pageMembre.goto("/demandes");
  await pageMembre.getByRole("navigation", { name: "Navigation principale" }).getByRole("link", { name: "Mes abonnements (1 abonnement à déclarer)" }).click();
  await expect(pageMembre.getByRole("heading", { level: 1 })).toHaveText("Mes abonnements");
  await expect(pageMembre.getByRole("region", { name: "À déclarer" }).getByRole("article", { name: new RegExp(echapper(offre)) })).toContainText("Durée de validité : 3 mois");
  await declarer(pageMembre, offre, { montant: "110", adresse: `${membre.uid}@gmail.com` });
  const ligne = pageMembre.getByRole("region", { name: "Abonnements déclarés" }).getByRole("row", { name: new RegExp(echapper(offre)) });
  await expect(ligne).toContainText(equipe);
  await expect(ligne).toContainText(`${membre.uid}@gmail.com`);
  await expect(ligne).toContainText("adresse hors LINAGORA");
  await expect(ligne).toContainText(/110,00\s€/);
  await expect(ligne).toContainText("Actif");
  await expect(pageMembre.getByRole("region", { name: "À déclarer" })).toHaveCount(0);

  // Une nouvelle demande du même salarié : sa fiche montre au responsable l'abonnement en cours.
  await demanderOffre(pageMembre, offre, equipe);
  await pageResponsable.goto("/gestion/demandes");
  await pageResponsable.getByRole("row", { name: new RegExp(`${membre.uid}.*Abonnement`) }).getByRole("link", { name: "Examiner" }).click();
  await expect(pageResponsable.getByRole("region", { name: "Abonnements en cours du demandeur" })).toContainText(`Anthropic · ${offre} · ${equipe}`);

  await nettoyer(situation);
});

test("le responsable suit l'abonnement de son équipe : à déclarer dans l'onglet, puis actif depuis la page de l'équipe et l'onglet filtré (ticket #56)", async ({ browser }) => {
  const situation = await abonnementApprouve(browser, "suivi");
  const { admin, pageResponsable, pageMembre, membre, equipe, pageEquipe, offre } = situation;

  // Avant la déclaration, l'onglet « Abonnements » le montre, à déclarer par le salarié ; sans pastille, car rien
  // n'y attend le responsable.
  await pageResponsable.goto("/gestion/demandes");
  await pageResponsable.getByRole("navigation", { name: "Administration" }).getByRole("link", { name: "Abonnements", exact: true }).click();
  await expect(pageResponsable.getByRole("heading", { level: 1 })).toHaveText("Abonnements");
  await expect(pageResponsable.getByRole("region", { name: "Abonnements approuvés, à déclarer par le collaborateur" }).getByRole("row", { name: new RegExp(membre.uid) })).toContainText(offre);

  // Déclaré, il apparaît dans le résumé de la page de l'équipe, qui mène à l'onglet filtré sur l'équipe.
  await declarer(pageMembre, offre, { montant: "108", adresse: `${membre.uid}@gmail.com` });
  await pageResponsable.goto(pageEquipe);
  await pageResponsable.getByRole("link", { name: /^1 abonnement actif, 108,00\s€ TTC par mois$/ }).click();
  await expect(pageResponsable.getByText(`Abonnements de l'équipe ${equipe}`)).toBeVisible();
  const actifs = pageResponsable.getByRole("region", { name: "Abonnements actifs" });
  await expect(actifs.getByRole("row")).toHaveCount(2);
  await expect(actifs.getByRole("row", { name: new RegExp(membre.uid) })).toContainText("adresse hors LINAGORA");
  await expect(pageResponsable.getByRole("region", { name: "Archive : abonnements résiliés" })).toContainText("Aucun abonnement résilié.");
  await expect(pageResponsable.getByRole("link", { name: "Tous les abonnements" })).toBeVisible();

  // L'admin le retrouve parmi tous les abonnements.
  await admin.goto("/gestion/abonnements");
  await expect(admin.getByRole("region", { name: "Abonnements actifs" }).getByRole("row", { name: new RegExp(membre.uid) })).toContainText(equipe);

  await nettoyer(situation);
});

test("le titulaire corrige le montant de son abonnement ; la gestion montre le montant corrigé et le prélèvement déjà compté (ticket #57)", async ({ browser }) => {
  const situation = await abonnementApprouve(browser, "montant");
  const { admin, pageMembre, membre, equipe, offre } = situation;
  await declarer(pageMembre, offre, { montant: "108", adresse: membre.email });

  // Déclaré au jour même, l'abonnement compte son premier prélèvement, que la gestion montre avec l'équipe imputée.
  const jour = new Intl.DateTimeFormat("fr-FR", { dateStyle: "long", timeZone: "UTC" }).format(new Date());
  await admin.goto("/gestion/abonnements");
  const ligne = admin.getByRole("region", { name: "Abonnements actifs" }).getByRole("row", { name: new RegExp(membre.uid) });
  await ligne.getByText(/^1 prélèvement, 108,00\s€ au total$/).click();
  await expect(ligne.getByRole("listitem")).toHaveText([new RegExp(`^${jour}\\s:\\s108,00\\s€, équipe ${echapper(equipe)}$`)]);

  // Le titulaire corrige le montant, qui vaut à partir du prochain prélèvement.
  await pageMembre.goto("/abonnements");
  const abonnement = pageMembre.getByRole("region", { name: "Abonnements déclarés" }).getByRole("row", { name: new RegExp(echapper(offre)) });
  await abonnement.getByText("Corriger le montant", { exact: true }).click();
  const correction = abonnement.getByRole("form", { name: `Corriger le montant : Anthropic · ${offre}` });
  await expect(correction).toContainText("Hausse de prix, change : la correction vaut à partir du prochain prélèvement.");
  await correction.getByLabel("Montant mensuel réel (€ TTC)").fill("120");
  await correction.getByRole("button", { name: "Enregistrer le montant" }).click();
  await expect(pageMembre.getByRole("status")).toHaveText("Montant corrigé : il vaut à partir du prochain prélèvement.");
  await expect(abonnement).toContainText(/120,00\s€/);

  // La gestion montre le nouveau montant ; le prélèvement déjà compté garde l'ancien.
  await admin.reload();
  await expect(ligne).toContainText(/120,00\s€/);
  await expect(ligne.getByText(/^1 prélèvement, 108,00\s€ au total$/)).toBeVisible();

  await nettoyer(situation);
});

test("le responsable demande la résiliation ; le titulaire, prévenu par courriel, la déclare, et l'abonnement passe dans l'archive (ticket #58)", async ({ browser }) => {
  const situation = await abonnementApprouve(browser, "resiliation");
  const { pageResponsable, pageMembre, responsable, membre, equipe, offre } = situation;
  await declarer(pageMembre, offre, { montant: "108", adresse: membre.email });

  // Le responsable demande la résiliation depuis l'onglet « Abonnements », avec un motif.
  await pageResponsable.goto("/gestion/abonnements");
  const ligne = pageResponsable.getByRole("region", { name: "Abonnements actifs" }).getByRole("row", { name: new RegExp(membre.uid) });
  await ligne.getByText("Demander la résiliation", { exact: true }).click();
  const demande = ligne.getByRole("form", { name: `Demander la résiliation : Anthropic · ${offre} de ${membre.uid}` });
  await demande.getByLabel("Motif").fill("Besoin disparu avec la fin du projet");
  await demande.getByRole("button", { name: "Envoyer la demande de résiliation" }).click();
  await expect(pageResponsable.getByRole("status")).toHaveText("Demande de résiliation envoyée au titulaire.");
  await expect(ligne).toContainText("À résilier");
  await expect(ligne).toContainText(`demandée par ${responsable.uid} le`);
  await expect(ligne).toContainText("Motif : Besoin disparu avec la fin du projet");

  // Le titulaire en est prévenu par courriel.
  const sujet = `[AI GATEWAY] Demande de résiliation de votre abonnement Anthropic · ${offre} / Cancellation request for your subscription Anthropic · ${offre}`;
  await expect.poll(async () => (await courriels(membre.uid)).map((c) => c.subject), { timeout: 15_000 }).toContain(sujet);
  const texte = (await courriels(membre.uid)).find((c) => c.subject === sujet)?.text ?? "";
  expect(texte).toContain(`Un responsable de votre équipe demande la résiliation de votre abonnement Anthropic · ${offre}, rattaché à l'équipe ${equipe}.`);
  expect(texte).toContain("Motif : Besoin disparu avec la fin du projet");
  expect(texte).toContain("Résiliez-le chez Anthropic, puis déclarez la résiliation dans « Mes abonnements » avant le");

  // Il déclare la résiliation dans « Mes abonnements ».
  await pageMembre.goto("/abonnements");
  const abonnement = pageMembre.getByRole("region", { name: "Abonnements déclarés" }).getByRole("row", { name: new RegExp(echapper(offre)) });
  await expect(abonnement).toContainText("Résiliation demandée le");
  await expect(abonnement).toContainText("Motif : Besoin disparu avec la fin du projet");
  await abonnement.getByText("Déclarer la résiliation", { exact: true }).click();
  const resiliation = abonnement.getByRole("form", { name: `Déclarer la résiliation : Anthropic · ${offre}` });
  await expect(resiliation).toContainText("Résiliez d'abord l'abonnement chez Anthropic, puis déclarez-en ici la date : aucun prélèvement ne compte à partir de ce jour.");
  await resiliation.getByRole("button", { name: "Confirmer la résiliation" }).click();
  await expect(pageMembre.getByRole("status")).toHaveText("Résiliation déclarée.");
  await expect(abonnement).toContainText("Résilié le");

  // L'abonnement résilié passe dans l'archive de la gestion.
  await pageResponsable.reload();
  await expect(pageResponsable.getByRole("region", { name: "Abonnements actifs" })).toContainText("Aucun abonnement actif.");
  await expect(pageResponsable.getByRole("region", { name: "Archive : abonnements résiliés" }).getByRole("row", { name: new RegExp(membre.uid) })).toContainText("Résilié le");

  await nettoyer(situation);
});

test("la sortie d'une équipe rend l'abonnement à résilier ; le responsable de l'équipe d'arrivée le rattache depuis la page de son équipe (ticket #58)", async ({ browser }) => {
  const situation = await abonnementApprouve(browser, "rattachement");
  const { admin, pageMembre, membre, equipe, pageEquipe, offre } = situation;
  await declarer(pageMembre, offre, { montant: "108", adresse: membre.email });

  // Une autre équipe du membre, avec son responsable.
  const responsableArrivee = personne("rattachement-arrivee");
  const pageArrivee = await (await connecter(browser, responsableArrivee)).newPage();
  const arrivee = `Équipe arrivée ${suffixe}`;
  await nouvelleEquipe(admin, arrivee);
  await designer(admin, responsableArrivee.uid);
  await ajouterMembre(admin, membre.uid);
  const pageEquipeArrivee = admin.url();

  // Sorti de sa première équipe, le membre a un abonnement à résilier, que la page de l'équipe d'arrivée propose de rattacher.
  await admin.goto(pageEquipe);
  await faireSortir(admin, membre.uid);
  await pageArrivee.goto(pageEquipeArrivee);
  const aRattacher = pageArrivee.getByRole("region", { name: "Abonnements à rattacher" });
  await expect(aRattacher.getByRole("row", { name: new RegExp(membre.uid) })).toContainText(equipe);
  await aRattacher.getByRole("form", { name: `Rattacher à cette équipe : Anthropic · ${offre} de ${membre.uid}` }).getByRole("button", { name: "Rattacher à cette équipe" }).click();
  await expect(pageArrivee.getByRole("status")).toHaveText("Abonnement rattaché à l'équipe.");
  await expect(pageArrivee.getByRole("region", { name: "Abonnements à rattacher" })).toHaveCount(0);
  await expect(pageArrivee.getByRole("link", { name: /^1 abonnement actif, 108,00\s€ TTC par mois$/ })).toBeVisible();

  // Le titulaire le retrouve actif, rattaché à sa nouvelle équipe.
  await pageMembre.goto("/abonnements");
  const abonnement = pageMembre.getByRole("region", { name: "Abonnements déclarés" }).getByRole("row", { name: new RegExp(echapper(offre)) });
  await expect(abonnement).toContainText(arrivee);
  await expect(abonnement).toContainText("Actif");

  // Nettoyage : l'équipe d'arrivée, puis la première, que le membre a déjà quittée, et l'offre.
  await viderEtSupprimer(admin, pageEquipeArrivee, [membre.uid, responsableArrivee.uid]);
  await viderEtSupprimer(admin, pageEquipe, [situation.responsable.uid]);
  await masquerOffre(admin, "Anthropic", offre);
});

/** Jour J + n (UTC), tel que l'écrit le portail en français : « 26 septembre 2026 ». */
const jourDansNJours = (n: number) => new Intl.DateTimeFormat("fr-FR", { dateStyle: "long", timeZone: "UTC" }).format(new Date(Date.now() + n * 86_400_000));

test("dès un mois avant l'échéance, le titulaire demande le renouvellement ; après l'accord du responsable, un admin l'approuve : l'échéance est reportée, sans nouvelle déclaration (tickets #59 et #95)", async ({ browser }) => {
  // Autorisé pour un mois, l'abonnement déclaré aujourd'hui est aussitôt renouvelable.
  const situation = await abonnementApprouve(browser, "renouvellement", "1 mois");
  const { admin, pageResponsable, pageMembre, membre, offre } = situation;
  await declarer(pageMembre, offre, { montant: "108", adresse: membre.email });
  const abonnement = pageMembre.getByRole("region", { name: "Abonnements déclarés" }).getByRole("row", { name: new RegExp(echapper(offre)) });
  await expect(abonnement).toContainText(jourDansNJours(30));

  // Le titulaire demande le renouvellement, prérempli avec sa demande d'origine.
  await abonnement.getByRole("link", { name: "Demander le renouvellement" }).click();
  await expect(pageMembre.getByRole("heading", { level: 1 })).toHaveText("Renouveler un abonnement");
  await expect(pageMembre.getByRole("region", { name: new RegExp(`Abonnement renouvelé.*${echapper(offre)}`) })).toContainText(`échéance le ${jourDansNJours(30)}`);
  await expect(pageMembre.getByText(/refusé, il vaut demande de résiliation de l'abonnement\.$/)).toBeVisible();
  await expect(pageMembre.getByLabel("Motif")).toHaveValue("Usage quotidien pour le projet");
  await pageMembre.getByLabel("Durée souhaitée").selectOption({ label: "6 mois" });
  await pageMembre.getByLabel(/Je m'engage à ne confier à cet abonnement/).check();
  await pageMembre.getByRole("button", { name: "Demander le renouvellement" }).click();
  await expect(pageMembre.getByRole("status")).toHaveText("Demande envoyée.");
  await pageMembre.goto("/abonnements");
  await expect(abonnement.getByRole("link", { name: "Renouvellement demandé" })).toBeVisible();

  // Le responsable y donne son accord depuis sa file : la fiche annonce un renouvellement.
  await examinerDemande(pageResponsable, membre);
  await expect(pageResponsable.getByText(`Renouvellement de l'abonnement Anthropic · ${offre}, qui arrive à échéance le ${jourDansNJours(30)}`)).toBeVisible();
  await donnerAccord(pageResponsable);

  // Un admin l'approuve, pour la durée demandée.
  await examinerDemande(admin, membre);
  await expect(admin.getByText(`Renouvellement de l'abonnement Anthropic · ${offre}, qui arrive à échéance le ${jourDansNJours(30)}`)).toBeVisible();
  await expect(admin.getByLabel("Durée de validité")).toHaveValue("180");
  await approuver(admin);

  // Le titulaire l'apprend par courriel ; son abonnement a sa nouvelle échéance, sans rien à déclarer.
  const sujet = "[AI GATEWAY] Votre demande de renouvellement est approuvée / Your renewal request is approved";
  await expect.poll(async () => (await courriels(membre.uid)).map((c) => c.subject), { timeout: 15_000 }).toContain(sujet);
  expect((await courriels(membre.uid)).find((c) => c.subject === sujet)?.text).toContain(`est reportée au ${jourDansNJours(210)} : rien d'autre à faire.`);
  await pageMembre.goto("/abonnements");
  await expect(abonnement).toContainText(jourDansNJours(210));
  await expect(pageMembre.getByRole("region", { name: "À déclarer" })).toHaveCount(0);
  await pageMembre.goto("/demandes");
  await expect(pageMembre.getByRole("row", { name: /Abonnement.*Échéance reportée/ })).toBeVisible();

  await nettoyer(situation);
});

test("le titulaire change d'offre ; après l'accord du responsable et l'approbation d'un admin, à la déclaration de la nouvelle offre, seul l'abonnement d'origine est résilié (tickets #59 et #95)", async ({ browser }) => {
  const situation = await abonnementApprouve(browser, "changement");
  const { admin, pageResponsable, pageMembre, membre, offre } = situation;
  await declarer(pageMembre, offre, { montant: "108", adresse: membre.email });
  const superieure = `Offre changement supérieure ${suffixe}`;
  await creerOffre(admin, { fournisseur: "Anthropic", nom: superieure, prix: "216", niveau: "N1 Public", reglesFr: "Désactivez l'entraînement sur vos données." });

  // Le titulaire demande à passer à l'offre supérieure du même fournisseur.
  await pageMembre.goto("/abonnements");
  const origine = pageMembre.getByRole("region", { name: "Abonnements déclarés" }).getByRole("row", { name: new RegExp(echapper(offre)) });
  await origine.getByRole("link", { name: "Changer d'offre" }).click();
  await expect(pageMembre.getByRole("heading", { level: 1 })).toHaveText("Changer d'offre");
  await expect(pageMembre.getByText(`Abonnement remplacé : Anthropic · ${offre}`)).toBeVisible();
  await pageMembre.getByRole("radio", { name: new RegExp(`^${echapper(superieure)} : 216,00\\s€ TTC par mois`) }).check();
  await pageMembre.getByLabel("Motif").fill("Besoin de plus de capacité");
  await pageMembre.getByLabel(/Je m'engage à ne confier à cet abonnement/).check();
  await pageMembre.getByRole("button", { name: "Demander le changement d'offre" }).click();
  await expect(pageMembre.getByRole("status")).toHaveText("Demande envoyée.");

  // Le responsable y donne son accord, puis un admin l'approuve ; le courriel annonce le remplacement.
  await examinerDemande(pageResponsable, membre);
  await expect(pageResponsable.getByText(`Changement d'offre : cet abonnement remplace l'abonnement Anthropic · ${offre}`)).toBeVisible();
  await donnerAccord(pageResponsable);
  await approuverDemande(admin, membre);
  const sujet = "[AI GATEWAY] Votre demande d'abonnement est approuvée / Your subscription request is approved";
  await expect.poll(async () => (await courriels(membre.uid)).filter((c) => c.subject === sujet).length, { timeout: 15_000 }).toBe(2);
  expect((await courriels(membre.uid)).map((c) => c.text).join("\n")).toContain(`Cet abonnement remplace votre abonnement Anthropic · ${offre}`);

  // Déclarée, la nouvelle offre remplace l'abonnement d'origine, résilié à la date de souscription déclarée.
  await declarer(pageMembre, superieure, { montant: "216", adresse: membre.email });
  const abonnements = pageMembre.getByRole("region", { name: "Abonnements déclarés" });
  await expect(abonnements.getByRole("row", { name: new RegExp(echapper(superieure)) })).toContainText("Actif");
  await expect(abonnements.getByRole("row", { name: new RegExp(echapper(offre)) })).toContainText(`Résilié le ${jourDansNJours(0)}`);

  await nettoyer(situation);
  await masquerOffre(admin, "Anthropic", superieure);
});

test("une demande d'abonnement attend l'accord de la responsable : à traiter chez elle, à part chez l'admin ; après l'accord, à approuver chez l'admin et en lecture seule chez elle (ticket #96)", async ({ browser }) => {
  const situation = await equipeEtOffre(browser, "attente");
  const { admin, pageResponsable, pageMembre, responsable, membre, equipe, offre } = situation;
  await demanderOffre(pageMembre, offre, equipe);

  // La demande part à la seule responsable ; elle l'attend, et sa pastille la compte ; chez l'admin, elle est à part.
  const sujet = `[AI GATEWAY] Nouvelle demande d'abonnement de ${membre.name} / New subscription request from ${membre.name}`;
  await expect.poll(async () => (await courriels(membre.uid)).find((c) => c.subject === sujet)?.to, { timeout: 15_000 }).toEqual([responsable.email]);
  await pageResponsable.goto("/");
  await pageResponsable.getByRole("link", { name: "Gestion (1 demande à valider)" }).click();
  await expect(ligneDeLaFile(pageResponsable, "À traiter", membre)).toBeVisible();
  await admin.goto("/gestion/demandes");
  await expect(ligneDeLaFile(admin, "En attente de l'accord d'un responsable", membre)).toBeVisible();
  await expect(ligneDeLaFile(admin, "À approuver", membre)).toHaveCount(0);

  // Après l'accord, elle attend l'admin ; la responsable la suit en lecture seule.
  await examinerDemande(pageResponsable, membre);
  await donnerAccord(pageResponsable);
  await expect(ligneDeLaFile(pageResponsable, "À traiter", membre)).toHaveCount(0);
  await ligneDeLaFile(pageResponsable, "En attente de l'approbation d'un administrateur", membre).getByRole("link", { name: "Voir" }).click();
  await expect(pageResponsable.getByText("Un responsable de l'équipe a donné son accord : la demande attend l'approbation d'un administrateur.")).toBeVisible();
  await expect(pageResponsable.getByRole("main").getByRole("button")).toHaveCount(0);
  await admin.reload();
  await expect(ligneDeLaFile(admin, "À approuver", membre)).toBeVisible();
  await approuverDemande(admin, membre);

  await nettoyer(situation);
});

test("sans autre responsable que son demandeur, une demande d'abonnement va directement aux admins ; un second responsable désigné, elle attend son accord (ticket #96)", async ({ browser }) => {
  const membre = personne("directe-membre");
  const second = personne("directe-second");
  const pageMembre = await (await connecter(browser, membre)).newPage();
  const pageSecond = await (await connecter(browser, second)).newPage();
  const admin = await (await connecter(browser, ADMIN)).newPage();
  const offre = `Offre directe ${suffixe}`;
  await creerOffre(admin, { fournisseur: "Anthropic", nom: offre, prix: "108", niveau: "N1 Public", reglesFr: "Désactivez l'entraînement sur vos données." });
  const equipe = `Équipe directe ${suffixe}`;
  await nouvelleEquipe(admin, equipe);
  await ajouterMembre(admin, membre.uid);
  await ajouterMembre(admin, second.uid);
  const pageEquipe = admin.url();

  // Équipe sans responsable : le formulaire l'annonce, la demande part aux admins et les attend.
  await pageMembre.goto("/catalogue/abonnements");
  await choisirOffre(pageMembre.getByRole("region", { name: "Anthropic" }), offre);
  await pageMembre.getByRole("region", { name: "Anthropic" }).getByRole("button", { name: "Demander cet abonnement" }).click();
  await pageMembre.getByLabel("Équipe").selectOption({ label: equipe });
  await expect(pageMembre.getByText("Votre demande sera approuvée par un administrateur.")).toBeVisible();
  await demanderOffre(pageMembre, offre, equipe);
  const sujet = `[AI GATEWAY] Nouvelle demande d'abonnement de ${membre.name} / New subscription request from ${membre.name}`;
  await expect.poll(async () => (await courriels(membre.uid)).find((c) => c.subject === sujet)?.to, { timeout: 15_000 }).toEqual(["admins-e2e@example.org"]);
  await admin.goto("/gestion/demandes");
  await expect(ligneDeLaFile(admin, "À approuver", membre)).toBeVisible();

  // Désigné seul responsable, le demandeur ne décide pas de sa propre demande : elle attend toujours les admins.
  await admin.goto(pageEquipe);
  await designer(admin, membre.uid);
  await pageMembre.goto("/gestion/demandes");
  await expect(ligneDeLaFile(pageMembre, "À traiter", membre)).toHaveCount(0);
  await admin.goto("/gestion/demandes");
  await expect(ligneDeLaFile(admin, "À approuver", membre)).toBeVisible();

  // Un second responsable : la demande attend désormais son accord, sans rien reprendre.
  await admin.goto(pageEquipe);
  await designer(admin, second.uid);
  await pageSecond.goto("/gestion/demandes");
  await expect(ligneDeLaFile(pageSecond, "À traiter", membre)).toBeVisible();
  await admin.goto("/gestion/demandes");
  await expect(ligneDeLaFile(admin, "En attente de l'accord d'un responsable", membre)).toBeVisible();

  await viderEtSupprimer(admin, pageEquipe, [membre.uid, second.uid]);
  await masquerOffre(admin, "Anthropic", offre);
});

/** Le membre complète, depuis « Mes demandes », sa demande d'abonnement renvoyée pour complément, et la resoumet. */
async function completer(pageMembre: Page): Promise<void> {
  await pageMembre.goto("/demandes");
  await pageMembre.getByRole("row", { name: /Abonnement.*À compléter/ }).getByRole("link", { name: "Compléter" }).click();
  await pageMembre.getByLabel(/Je m'engage à ne confier à cet abonnement/).check();
  await pageMembre.getByRole("button", { name: "Resoumettre" }).click();
  await expect(pageMembre.getByRole("status")).toHaveText("Demande complétée et resoumise.");
}

test("renvoyée pour complément, une demande d'abonnement complétée revient à l'étape qu'elle avait quittée ; après l'accord, son demandeur peut encore l'annuler (ticket #98)", async ({ browser }) => {
  const situation = await equipeEtOffre(browser, "complement");
  const { admin, pageResponsable, pageMembre, membre, equipe, offre } = situation;
  await demanderOffre(pageMembre, offre, equipe);

  // Avant son accord, la responsable demande un complément ; complétée, la demande redevient soumise et l'attend.
  await examinerDemande(pageResponsable, membre);
  await demanderComplement(pageResponsable, "Précisez le projet");
  await completer(pageMembre);
  await pageResponsable.goto("/gestion/demandes");
  await expect(ligneDeLaFile(pageResponsable, "À traiter", membre)).toBeVisible();

  // Après l'accord, l'admin demande un complément ; complétée, la demande revient à l'accord, sans qu'on le redemande.
  await examinerDemande(pageResponsable, membre);
  await donnerAccord(pageResponsable);
  await examinerDemande(admin, membre);
  await demanderComplement(admin, "Précisez la durée");
  await completer(pageMembre);
  await expect(pageMembre.getByRole("row", { name: new RegExp(`Abonnement.*${echapper(equipe)}.*Accord du responsable`) })).toBeVisible();
  await admin.goto("/gestion/demandes");
  await expect(ligneDeLaFile(admin, "À approuver", membre)).toBeVisible();

  // Son demandeur l'annule encore.
  await pageMembre.getByRole("row", { name: /Abonnement.*Accord du responsable/ }).getByRole("button", { name: "Annuler" }).click();
  await expect(pageMembre.getByRole("status")).toHaveText("Demande annulée.");
  await expect(pageMembre.getByRole("row", { name: new RegExp(`Abonnement.*${echapper(equipe)}.*Annulée`) })).toBeVisible();

  await nettoyer(situation);
});

test("la responsable refuse une demande soumise, définitivement ; l'admin refuse une demande après l'accord ; le demandeur, les admins et la responsable en sont prévenus (ticket #98)", async ({ browser }) => {
  const situation = await equipeEtOffre(browser, "refus");
  const { admin, pageResponsable, pageMembre, responsable, membre, equipe, offre } = situation;
  await demanderOffre(pageMembre, offre, equipe);
  await demanderOffre(pageMembre, offre, equipe);
  const traitee = `[AI GATEWAY] Demande traitée dans l'équipe ${equipe} : ${membre.uid} / Request processed in the team ${equipe}: ${membre.uid}`;
  const annonces = async () => (await courriels(membre.uid)).filter((c) => c.subject === traitee).map((c) => c.to);

  // La responsable refuse la première : le demandeur et les admins en sont prévenus.
  await examinerDemande(pageResponsable, membre);
  await refuser(pageResponsable, "Offre trop coûteuse pour ce besoin");
  await expect.poll(annonces, { timeout: 15_000 }).toEqual([["admins-e2e@example.org"]]);

  // Elle donne son accord à la seconde, que l'admin refuse : la responsable en est prévenue.
  await examinerDemande(pageResponsable, membre);
  await donnerAccord(pageResponsable);
  await examinerDemande(admin, membre);
  await refuser(admin, "Hors budget cette année");
  await expect.poll(annonces, { timeout: 15_000 }).toEqual(expect.arrayContaining([["admins-e2e@example.org"], [responsable.email]]));
  await expect.poll(async () => (await courriels(membre.uid)).filter((c) => c.subject === "[AI GATEWAY] Votre demande est refusée / Your request is refused").length, { timeout: 15_000 }).toBe(2);
  await pageMembre.goto("/demandes");
  await expect(pageMembre.getByRole("row", { name: new RegExp(`Abonnement.*${echapper(equipe)}.*Refusée`) })).toHaveCount(2);

  await nettoyer(situation);
});

test("l'admin approuve une demande sans attendre l'accord de la responsable : la fiche l'en avertit, et l'annonce à la responsable le dit (ticket #97)", async ({ browser }) => {
  // Un seul mot : le parcours en anglais n'excuse que les noms d'équipe de test d'un seul mot.
  const situation = await equipeEtOffre(browser, "sansaccord");
  const { admin, pageMembre, responsable, membre, equipe, offre } = situation;
  await demanderOffre(pageMembre, offre, equipe);

  await examinerDemande(admin, membre);
  await expect(admin.getByText(/^Sans accord d'un responsable\s:\sun responsable de l'équipe n'a pas encore donné son accord\./)).toBeVisible();
  await approuver(admin);

  const traitee = `[AI GATEWAY] Demande traitée dans l'équipe ${equipe} : ${membre.uid} / Request processed in the team ${equipe}: ${membre.uid}`;
  const annonce = async () => (await courriels(membre.uid)).find((c) => c.subject === traitee);
  await expect.poll(async () => (await annonce())?.to, { timeout: 15_000 }).toEqual([responsable.email]);
  expect((await annonce())?.text).toContain(`a approuvé la demande d'abonnement de ${membre.uid}, sans attendre l'accord d'un responsable de l'équipe.`);

  await nettoyer(situation);
});
