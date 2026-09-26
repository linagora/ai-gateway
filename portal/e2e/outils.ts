import { type APIRequestContext, type Browser, type BrowserContext, expect, type Locator, type Page } from "@playwright/test";

export interface Personne {
  uid: string;
  email: string;
  name: string;
}

/** Ouvre une session dans un contexte de navigateur réglé sur la langue donnée (en-tête Accept-Language). */
export async function connecter(browser: Browser, personne: Personne, langueNavigateur = "fr-FR"): Promise<BrowserContext> {
  const context = await browser.newContext({ locale: langueNavigateur });
  const page = await context.newPage();
  await page.goto("/");
  await page.getByRole("button", { name: /LemonLDAP/ }).click();
  // Formulaire du fournisseur OIDC simulé : uid (= sub) et claims.
  await page.locator('input[name="username"]').fill(personne.uid);
  await page.locator('textarea[name="claims"]').fill(JSON.stringify({ email: personne.email, name: personne.name }));
  await page.getByRole("button", { name: "Sign-in" }).click();
  await expect(page.getByRole("heading", { name: new RegExp(personne.name) })).toBeVisible();
  await page.close();
  return context;
}

export const ADMIN: Personne = { uid: "mmaudet", email: "mmaudet@linagora.com", name: "Admin E2E" };

const CAS_USAGE = ["Rédaction et analyse", "Code", "Extraction et automatisation", "Création d'images"];

/**
 * Enrichit un modèle de démonstration depuis la gestion du catalogue (session admin), et le rend visible.
 * Les cas d'usage et les recommandations, s'ils sont donnés, remplacent ceux de la fiche.
 */
export async function enrichirModele(
  page: Page,
  modele: { nom: string; nomAffiche: string; niveau: string; casUsage?: string[]; recommandePour?: string[] },
): Promise<void> {
  await page.goto("/gestion/catalogue");
  const section = page.locator("section").filter({ has: page.locator("code", { hasText: new RegExp(`^${modele.nom}$`) }) });
  await section.getByLabel("Nom affiché (français)").fill(modele.nomAffiche);
  await section.getByLabel("Description courte (français)").fill(`Modèle de démonstration ${modele.niveau}`);
  await section.getByLabel("Description longue (français)").fill(`Modèle de démonstration ${modele.niveau}, à réponses simulées.`);
  await section.getByLabel("Niveau maximal").selectOption(modele.niveau);
  await section.getByLabel("Visible des collaborateurs").check();
  for (const [groupe, coches] of [["Cas d'usage", modele.casUsage], ["Recommandé pour", modele.recommandePour]] as const) {
    if (!coches) continue;
    for (const cas of CAS_USAGE) await section.getByRole("group", { name: groupe }).getByLabel(cas, { exact: true }).setChecked(coches.includes(cas));
  }
  await section.getByRole("button", { name: "Enregistrer" }).click();
  await expect(page.getByRole("status")).toHaveText("Catalogue mis à jour.");
}

/** Mise en place (LiteLLM de développement) : rend une personne, déjà connectée une fois, membre d'une équipe. */
export async function ajouterAEquipe(uid: string, equipe: string): Promise<void> {
  const base = "http://127.0.0.1:54400/admin";
  const entetes = { Authorization: "Bearer sk-dev-master-key", "Content-Type": "application/json" };
  const equipes = (await (await fetch(`${base}/team/list`, { headers: entetes })).json()) as { team_id: string; team_alias: string }[];
  const cible = equipes.find((e) => e.team_alias === equipe);
  if (!cible) throw new Error(`équipe ${equipe} absente du LiteLLM de développement`);
  const reponse = await fetch(`${base}/team/member_add`, {
    method: "POST",
    headers: entetes,
    body: JSON.stringify({ team_id: cible.team_id, member: { role: "user", user_id: uid } }),
  });
  if (!reponse.ok && !(await reponse.text()).includes("already")) throw new Error(`ajout à l'équipe ${equipe} : HTTP ${reponse.status}`);
}

/**
 * Mise en place : le salarié, déjà connecté une fois (page ouverte), rejoint R&D et demande une clé N1 pour le
 * modèle public ; un admin l'approuve avec un budget de 5 € par 30 jours, valable 30 jours.
 */
export async function demandeApprouvee(browser: Browser, page: Page, salarie: Personne, projet: string): Promise<void> {
  await ajouterAEquipe(salarie.uid, "R&D");
  await demanderEtApprouver(browser, page, salarie, { equipe: "R&D", projet });
}

/**
 * Le salarié, déjà membre de l'équipe (page ouverte), y demande une clé N1 pour le modèle public ; un admin l'approuve
 * avec un budget de 5 € par 30 jours, valable 30 jours.
 */
export async function demanderEtApprouver(browser: Browser, page: Page, salarie: Personne, { equipe, projet }: { equipe: string; projet: string }): Promise<void> {
  await page.goto("/demandes/nouvelle");
  await page.getByLabel("Équipe").selectOption({ label: equipe });
  await page.getByRole("radio", { name: /^N1 Public/ }).check();
  await page.getByLabel(/Modèle public/).check();
  await page.getByLabel("Motif").fill("Essai des clés");
  await page.getByLabel("Projet ou affaire").fill(projet);
  await page.getByLabel(/Je m'engage/).check();
  await page.getByRole("button", { name: "Envoyer la demande" }).click();
  await expect(page.getByRole("status")).toHaveText("Demande envoyée aux administrateurs.");

  const admin = await (await connecter(browser, ADMIN)).newPage();
  await admin.goto("/gestion/demandes");
  await admin.getByRole("row", { name: new RegExp(`${salarie.uid}.*Clé d'API.*${echapper(equipe)}`) }).getByRole("link", { name: "Examiner" }).click();
  await admin.getByLabel("Budget (€)").fill("5");
  await admin.getByLabel("Période du budget (ex. 30d)").fill("30d");
  await admin.getByLabel("Durée de validité").selectOption({ label: "1 mois" });
  await admin.getByRole("button", { name: "Approuver", exact: true }).click();
  await expect(admin.getByRole("status")).toHaveText("Demande approuvée.");
  await admin.context().close();
}

/** Courriel reçu par Mailpit (faux serveur de courriel de l'environnement de développement). */
export interface CourrielRecu {
  to: string[];
  subject: string;
  text: string;
}

/** Courriels reçus par Mailpit qui contiennent le texte recherché (par exemple l'uid d'une personne de test). */
export async function courriels(recherche: string): Promise<CourrielRecu[]> {
  const base = "http://127.0.0.1:54825/api/v1";
  const { messages } = (await (await fetch(`${base}/search?query=${encodeURIComponent(recherche)}`)).json()) as {
    messages: { ID: string; Subject: string; To: { Address: string }[] }[];
  };
  return Promise.all(
    messages.map(async (m) => {
      const { Text } = (await (await fetch(`${base}/message/${m.ID}`)).json()) as { Text: string };
      return { to: m.To.map((t) => t.Address), subject: m.Subject, text: Text };
    }),
  );
}

/** Échappe un texte pour l'insérer tel quel dans une expression régulière. */
export const echapper = (texte: string) => texte.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Point d'accès de la passerelle de développement, pour les appels réels faits avec une clé. */
export const PASSERELLE = "http://127.0.0.1:54400/admin/v1/chat/completions";

/** Statut HTTP d'un appel réel au modèle public avec une clé. */
export async function appel(request: APIRequestContext, cle: string): Promise<number> {
  const reponse = await request.post(PASSERELLE, { headers: { Authorization: `Bearer ${cle}` }, data: { model: "dev-public", messages: [{ role: "user", content: "Bonjour" }] } });
  return reponse.status();
}

/** Le titulaire retire sa clé approuvée depuis « Mes clés » et la rend, après avoir confirmé l'avoir copiée. */
export async function retirerCle(page: Page): Promise<string> {
  await page.goto("/cles");
  await page.getByRole("region", { name: "À retirer" }).getByRole("button", { name: "Générer ma clé" }).click();
  const panneau = page.getByRole("region", { name: /Votre nouvelle clé/ });
  const cle = ((await panneau.locator("code").textContent()) ?? "").trim();
  await panneau.getByRole("button", { name: "J'ai copié ma clé" }).click();
  await expect(panneau).toHaveCount(0);
  return cle;
}

// --- Équipes : parcours de la gestion par un admin ou un responsable ---

/** Sur la page d'une équipe, l'admin fait sortir un membre, avec confirmation. */
export async function faireSortir(admin: Page, uid: string): Promise<void> {
  const ligne = admin.getByRole("region", { name: "Membres" }).getByRole("row", { name: new RegExp(uid) });
  await ligne.getByText("Faire sortir de l'équipe").click();
  await ligne.getByRole("button", { name: "Confirmer la sortie" }).click();
  await expect(admin.getByRole("status")).toHaveText("Le membre est sorti de l'équipe : ses clés de l'équipe sont révoquées.");
}

/** Sur la page d'une équipe, l'admin ajoute directement un salarié déjà connecté. */
export async function ajouterMembre(admin: Page, uid: string): Promise<void> {
  await admin.getByLabel("Uid du collaborateur").fill(uid);
  await admin.getByRole("button", { name: "Ajouter à l'équipe" }).click();
  await expect(admin.getByRole("status")).toHaveText("Membre ajouté.");
}

/** Sur la page d'une équipe, l'admin désigne un responsable parmi les salariés déjà connectés. */
export async function designer(admin: Page, uid: string): Promise<void> {
  await admin.getByLabel("Uid du responsable").fill(uid);
  await admin.getByRole("button", { name: "Désigner responsable" }).click();
  await expect(admin.getByRole("status")).toHaveText("Responsable désigné.");
}

/** Sur la page d'une équipe, l'admin demande sa suppression, avec confirmation. */
export async function supprimerEquipe(admin: Page): Promise<void> {
  const zone = admin.getByRole("region", { name: "Suppression de l'équipe" });
  await zone.getByText("Supprimer l'équipe").click();
  await zone.getByRole("button", { name: "Confirmer la suppression" }).click();
}

/** Un admin crée une équipe au nom unique et ouvre sa page. */
export async function nouvelleEquipe(admin: Page, nom: string): Promise<void> {
  await admin.goto("/gestion/equipes");
  await admin.getByLabel("Nom de la nouvelle équipe").fill(nom);
  await admin.getByRole("button", { name: "Créer l'équipe" }).click();
  await expect(admin.getByRole("status")).toHaveText("Équipe créée.");
  await admin.getByRole("link", { name: nom, exact: true }).click();
  await expect(admin.getByRole("heading", { level: 1 })).toHaveText(nom);
}

// --- Abonnements : offres, demandes, approbation et déclaration ---

/** Champs d'une offre saisis par un admin. */
export interface Offre {
  fournisseur: string;
  nom: string;
  prix: string;
  niveau: string;
  reglesFr: string;
  reglesEn?: string;
  lien?: string;
}

/** Un admin crée une offre visible depuis la gestion du catalogue. */
export async function creerOffre(admin: Page, offre: Offre): Promise<void> {
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
export async function masquerOffre(admin: Page, fournisseur: string, nom: string): Promise<void> {
  await admin.goto("/gestion/catalogue");
  const formulaire = admin.getByRole("form", { name: `${fournisseur} · ${nom}` });
  await formulaire.getByLabel("Visible au catalogue").uncheck();
  await formulaire.getByRole("button", { name: "Enregistrer l'offre" }).click();
  await expect(admin.getByRole("status")).toHaveText("Offre enregistrée.");
}

/**
 * Dans la carte d'un fournisseur de la page des abonnements, choisit une offre par son nom dans la liste, la seule de la
 * carte : trouvée par son rôle, quelle que soit la langue (l'étiquette englobe aussi le texte des offres).
 */
export async function choisirOffre(fournisseur: Locator, nom: string): Promise<void> {
  const valeur = await fournisseur.getByRole("option", { name: new RegExp(`^${echapper(nom)} · `) }).getAttribute("value");
  await fournisseur.getByRole("combobox").selectOption(valeur ?? "");
}

/**
 * Le membre (page ouverte) demande l'offre du fournisseur (Anthropic) pour l'équipe, pour la durée donnée (trois mois),
 * en prenant l'engagement.
 */
export async function demanderOffre(pageMembre: Page, offre: string, equipe: string, duree = "3 mois", fournisseur = "Anthropic"): Promise<void> {
  await pageMembre.goto("/catalogue/abonnements");
  const carte = pageMembre.getByRole("region", { name: fournisseur });
  await choisirOffre(carte, offre);
  await carte.getByRole("button", { name: "Demander cet abonnement" }).click();
  await pageMembre.getByLabel("Équipe").selectOption({ label: equipe });
  await pageMembre.getByLabel("Motif").fill("Usage quotidien pour le projet");
  await pageMembre.getByLabel("Durée souhaitée").selectOption({ label: duree });
  await pageMembre.getByLabel(/Je m'engage à ne confier à cet abonnement/).check();
  await pageMembre.getByRole("button", { name: "Envoyer la demande" }).click();
  await expect(pageMembre.getByRole("status")).toHaveText("Demande envoyée aux administrateurs.");
}

/** Le responsable (page ouverte) approuve, depuis sa file, la demande d'abonnement du membre. */
export async function approuverDemande(pageResponsable: Page, membre: Personne): Promise<void> {
  await pageResponsable.goto("/gestion/demandes");
  await pageResponsable.getByRole("row", { name: new RegExp(`${membre.uid}.*Abonnement`) }).first().getByRole("link", { name: "Examiner" }).click();
  await pageResponsable.getByRole("button", { name: "Approuver", exact: true }).click();
  await expect(pageResponsable.getByRole("status")).toHaveText("Demande approuvée.");
}

/** Le membre déclare dans « Mes abonnements » l'abonnement approuvé, au jour même, avec l'adresse et le montant donnés. */
export async function declarer(pageMembre: Page, offre: string, { montant, adresse }: { montant: string; adresse: string }): Promise<void> {
  await pageMembre.goto("/abonnements");
  const carte = pageMembre.getByRole("region", { name: "À déclarer" }).getByRole("article", { name: new RegExp(echapper(offre)) });
  await carte.getByLabel("Montant mensuel prélevé (€ TTC)").fill(montant);
  await carte.getByLabel("Adresse du compte chez le fournisseur").fill(adresse);
  await carte.getByRole("button", { name: "Déclarer l'abonnement" }).click();
  await expect(pageMembre.getByRole("status")).toHaveText("Abonnement déclaré.");
}
