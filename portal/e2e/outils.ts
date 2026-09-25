import { type Browser, type BrowserContext, expect, type Page } from "@playwright/test";

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

const CAS_USAGE = [
  "Rédaction et synthèse",
  "Code",
  "Analyse de documents longs",
  "Traduction",
  "Extraction et classement",
  "Raisonnement et analyse",
  "Décision structurée",
];

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
  await section.getByLabel("Visible des salariés").check();
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
  await page.goto("/demandes/nouvelle");
  await page.getByLabel("Équipe").selectOption({ label: "R&D" });
  await page.getByRole("radio", { name: /^N1 — Public/ }).check();
  await page.getByLabel(/Modèle public/).check();
  await page.getByLabel("Motif").fill("Essai des clés");
  await page.getByLabel("Projet ou affaire").fill(projet);
  await page.getByLabel(/Je m'engage/).check();
  await page.getByRole("button", { name: "Envoyer la demande" }).click();
  await expect(page.getByRole("status")).toHaveText("Demande envoyée aux administrateurs.");

  const admin = await (await connecter(browser, ADMIN)).newPage();
  await admin.goto("/gestion/demandes");
  await admin.getByRole("row", { name: new RegExp(`${salarie.uid}.*Clé d'API`) }).getByRole("link", { name: "Examiner" }).click();
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
