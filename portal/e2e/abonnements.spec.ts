import { type Browser, expect, type Page, test } from "@playwright/test";
import { ADMIN, ajouterMembre, connecter, courriels, designer, echapper, faireSortir, nouvelleEquipe, type Personne, supprimerEquipe } from "./outils";

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

/** Le membre (page ouverte) demande l'offre pour l'équipe, pour trois mois, en prenant l'engagement. */
async function demanderOffre(pageMembre: Page, offre: string, equipe: string): Promise<void> {
  await pageMembre.goto("/catalogue/abonnements");
  await pageMembre.getByRole("article", { name: offre }).getByRole("link", { name: "Demander cet abonnement" }).click();
  await pageMembre.getByLabel("Équipe").selectOption({ label: equipe });
  await pageMembre.getByLabel("Motif").fill("Usage quotidien pour le projet");
  await pageMembre.getByLabel("Durée souhaitée").selectOption({ label: "3 mois" });
  await pageMembre.getByLabel(/Je m'engage à ne confier à cet abonnement/).check();
  await pageMembre.getByRole("button", { name: "Envoyer la demande" }).click();
  await expect(pageMembre.getByRole("status")).toHaveText("Demande envoyée aux administrateurs.");
}

/** Le responsable (page ouverte) approuve, depuis sa file, la demande d'abonnement du membre. */
async function approuverDemande(pageResponsable: Page, membre: Personne): Promise<void> {
  await pageResponsable.goto("/gestion/demandes");
  await pageResponsable.getByRole("row", { name: new RegExp(`${membre.uid}.*Abonnement`) }).first().getByRole("link", { name: "Examiner" }).click();
  await pageResponsable.getByRole("button", { name: "Approuver", exact: true }).click();
  await expect(pageResponsable.getByRole("status")).toHaveText("Demande approuvée.");
}

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

/**
 * Mise en place : une offre visible, une équipe avec son responsable et son membre, et la demande d'abonnement du
 * membre approuvée par le responsable.
 */
async function abonnementApprouve(browser: Browser, nom: string): Promise<Situation> {
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
  const pageEquipe = admin.url();
  await demanderOffre(pageMembre, offre, equipe);
  await approuverDemande(pageResponsable, membre);
  return { admin, pageResponsable, pageMembre, responsable, membre, equipe, pageEquipe, offre };
}

/** Le membre déclare dans « Mes abonnements » l'abonnement approuvé, au jour même, avec l'adresse et le montant donnés. */
async function declarer(pageMembre: Page, offre: string, { montant, adresse }: { montant: string; adresse: string }): Promise<void> {
  await pageMembre.goto("/abonnements");
  const carte = pageMembre.getByRole("region", { name: "À déclarer" }).getByRole("article", { name: new RegExp(echapper(offre)) });
  await carte.getByLabel("Montant mensuel prélevé (€ TTC)").fill(montant);
  await carte.getByLabel("Adresse du compte chez le fournisseur").fill(adresse);
  await carte.getByRole("button", { name: "Déclarer l'abonnement" }).click();
  await expect(pageMembre.getByRole("status")).toHaveText("Abonnement déclaré.");
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

test("un membre demande une offre pour son équipe ; le responsable l'approuve, et le courriel explique comment souscrire puis déclarer (ticket #54)", async ({ browser }) => {
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
  await pageMembre.getByRole("article", { name: nomOffre }).getByRole("link", { name: "Demander cet abonnement" }).click();
  await expect(pageMembre.getByRole("heading", { level: 1 })).toHaveText("Demander un abonnement");
  await expect(pageMembre.getByRole("region", { name: new RegExp(`Offre demandée.*${echapper(nomOffre)}`) })).toContainText(/23,00\s€ TTC par mois/);
  await pageMembre.getByLabel("Équipe").selectOption({ label: equipe });
  await expect(pageMembre.getByText(`Votre demande sera validée par : ${responsable.uid}.`)).toBeVisible();
  await pageMembre.getByLabel("Motif").fill("Rédaction assistée des comptes rendus");
  await pageMembre.getByLabel("Durée souhaitée").selectOption({ label: "6 mois" });
  await pageMembre.getByLabel(/Je m'engage à ne confier à cet abonnement/).check();
  await pageMembre.getByRole("button", { name: "Envoyer la demande" }).click();
  await expect(pageMembre.getByRole("status")).toHaveText("Demande envoyée aux administrateurs.");
  await expect(pageMembre.getByRole("row", { name: new RegExp(`Abonnement.*${echapper(equipe)}.*OpenAI · ${echapper(nomOffre)}.*Soumise`) })).toBeVisible();

  // Le responsable l'examine et l'approuve pour six mois.
  await pageResponsable.goto("/gestion/demandes");
  await pageResponsable.getByRole("row", { name: new RegExp(`${membre.uid}.*Abonnement`) }).getByRole("link", { name: "Examiner" }).click();
  await expect(pageResponsable.getByRole("main")).toContainText(`${nomOffre} (OpenAI)`);
  await expect(pageResponsable.getByLabel("Durée de validité")).toHaveValue("180");
  await pageResponsable.getByRole("button", { name: "Approuver", exact: true }).click();
  await expect(pageResponsable.getByRole("status")).toHaveText("Demande approuvée.");

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

  // Avant la déclaration, l'onglet « Abonnements » le signale, à déclarer.
  await pageResponsable.goto("/gestion/demandes");
  await pageResponsable.getByRole("navigation", { name: "Administration" }).getByRole("link", { name: "Abonnements (1 abonnement à déclarer)" }).click();
  await expect(pageResponsable.getByRole("heading", { level: 1 })).toHaveText("Abonnements");
  await expect(pageResponsable.getByRole("region", { name: "Abonnements approuvés, à déclarer par le salarié" }).getByRole("row", { name: new RegExp(membre.uid) })).toContainText(offre);

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
