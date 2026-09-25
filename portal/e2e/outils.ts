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
