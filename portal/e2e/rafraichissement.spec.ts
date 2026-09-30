import { type Browser, expect, type Page, test } from "@playwright/test";
import { ADMIN, connecter, designer, faireSortir, ligneDeLaFile, nouvelleEquipe, type Personne, refuser, supprimerEquipe } from "./outils";

/*
 * Rafraîchissement automatique de la gestion (ticket #102) : toutes les 30 secondes, la page se met à jour sans être
 * rechargée ; il attend la fin d'une saisie, se met en pause quand l'onglet est caché, et ne vaut que pour la gestion.
 * L'horloge du navigateur est simulée : chaque parcours avance le temps lui-même.
 */
const suffixe = Date.now().toString(36);
const personne = (n: string): Personne => ({ uid: `rafraichissement-${n}-${suffixe}`, email: `rafraichissement-${n}-${suffixe}@example.org`, name: `Personne ${n} ${suffixe}` });

/** Un nouveau collaborateur demande à rejoindre l'équipe : sa demande arrive dans la file et sur la pastille. */
async function nouvelleDemande(browser: Browser, nom: string, equipe = "R&D"): Promise<Personne> {
  const collaborateur = personne(nom);
  const context = await connecter(browser, collaborateur);
  const page = await context.newPage();
  await page.goto("/demandes/adhesion");
  await page.getByLabel("Équipe").selectOption({ label: equipe });
  await page.getByLabel("Motif").fill("Rejoindre l'équipe");
  await page.getByRole("button", { name: "Envoyer la demande" }).click();
  await expect(page.getByRole("status")).toHaveText("Demande d'accès envoyée.");
  await context.close();
  return collaborateur;
}

/** Marque la page : un rechargement effacerait la marque. */
async function marquer(page: Page): Promise<void> {
  await page.evaluate(() => Object.assign(window, { marque: "sans rechargement" }));
}

async function sansRechargement(page: Page): Promise<void> {
  expect(await page.evaluate(() => (window as unknown as { marque?: string }).marque)).toBe("sans rechargement");
}

/** Page ouverte par l'admin, sous horloge simulée, et marquée. */
async function ouvrir(browser: Browser, chemin: string): Promise<Page> {
  const admin = await (await connecter(browser, ADMIN)).newPage();
  await admin.clock.install();
  await admin.goto(chemin);
  await marquer(admin);
  return admin;
}

/** Lien « Gestion » de l'en-tête, dont la pastille compte les demandes à valider. */
const lienGestion = (page: Page) => page.getByRole("banner").getByRole("link", { name: /^Gestion/ });

/**
 * Nombre de demandes à valider que compte la pastille. Juste après l'hydratation, les liens des menus sont recréés :
 * un instantané pris à cet instant est vide, et l'on attend le suivant.
 */
async function pastille(page: Page): Promise<number> {
  let instantane = "";
  await expect.poll(async () => (instantane = await lienGestion(page).ariaSnapshot())).not.toBe("");
  return Number(/\((\d+) demandes? à valider\)/.exec(instantane)?.[1] ?? 0);
}

/** Nom du lien « Gestion » : sans pastille quand rien n'attend. */
const nomDuLien = (nombre: number) => (nombre === 0 ? "Gestion" : `Gestion (${nombre} ${nombre > 1 ? "demandes" : "demande"} à valider)`);

/** Aucun changement : un rafraîchissement lancé à tort aurait eu le temps d'arriver. */
async function inchangee(page: Page, nombre: number): Promise<void> {
  await page.waitForTimeout(1_500);
  await expect(lienGestion(page)).toHaveAccessibleName(nomDuLien(nombre));
}

/** Onglet caché ou de nouveau visible, comme quand l'utilisateur passe à un autre onglet puis revient. */
async function onglet(page: Page, etat: "hidden" | "visible"): Promise<void> {
  await page.evaluate((etat) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => etat });
    document.dispatchEvent(new Event("visibilitychange"));
  }, etat);
}

test("toutes les 30 secondes, la file de la gestion et la pastille se mettent à jour, sans recharger la page", async ({ browser }) => {
  const admin = await ouvrir(browser, "/gestion/demandes");
  const avant = await pastille(admin);
  const demandeur = await nouvelleDemande(browser, "file");
  await expect(ligneDeLaFile(admin, "À approuver", demandeur)).toHaveCount(0);

  await admin.clock.runFor(30_000);
  await expect(ligneDeLaFile(admin, "À approuver", demandeur)).toBeVisible();
  await expect(lienGestion(admin)).toHaveAccessibleName(nomDuLien(avant + 1));
  await sansRechargement(admin);
});

test("rien ne se rafraîchit pendant une saisie ni quand on agit dans un panneau ; un panneau laissé ouvert ne bloque rien", async ({ browser }) => {
  const admin = await ouvrir(browser, "/gestion/equipes");
  const avant = await pastille(admin);
  await admin.getByLabel("Nom de la nouvelle équipe").fill("Équipe en cours de saisie");
  await nouvelleDemande(browser, "saisie");
  await admin.clock.runFor(60_000);
  await inchangee(admin, avant);
  await expect(admin.getByLabel("Nom de la nouvelle équipe")).toHaveValue("Équipe en cours de saisie");

  // Sur la page d'une équipe, un panneau de confirmation ouvert et le focus dedans : toujours rien.
  await admin.getByRole("link", { name: "R&D", exact: true }).click();
  await expect(admin.getByRole("heading", { level: 1 })).toHaveText("R&D");
  const membres = admin.getByRole("region", { name: "Membres" });
  await membres.getByText("Faire sortir de l'équipe").first().click();
  await admin.clock.runFor(60_000);
  await inchangee(admin, avant);

  // Le focus ailleurs, le panneau resté ouvert ne bloque plus : la page se met à jour, et il reste ouvert.
  await admin.getByRole("heading", { level: 1 }).click();
  await admin.clock.runFor(30_000);
  await expect(lienGestion(admin)).toHaveAccessibleName(nomDuLien(avant + 1));
  await expect(membres.getByRole("button", { name: "Confirmer la sortie" }).first()).toBeVisible();
  await sansRechargement(admin);
});

test("onglet caché, la gestion ne se rafraîchit pas ; au retour sur l'onglet, elle se met à jour aussitôt", async ({ browser }) => {
  const admin = await ouvrir(browser, "/gestion/demandes");
  const avant = await pastille(admin);
  await onglet(admin, "hidden");
  const demandeur = await nouvelleDemande(browser, "cache");
  await admin.clock.runFor(90_000);
  await inchangee(admin, avant);

  await onglet(admin, "visible");
  await expect(ligneDeLaFile(admin, "À approuver", demandeur)).toBeVisible();
  await expect(lienGestion(admin)).toHaveAccessibleName(nomDuLien(avant + 1));
  await sansRechargement(admin);
});

test("hors de la gestion, aucune page ne se met à jour d'elle-même", async ({ browser }) => {
  const admin = await ouvrir(browser, "/demandes");
  const avant = await pastille(admin);
  await nouvelleDemande(browser, "hors");
  await admin.clock.runFor(90_000);
  await inchangee(admin, avant);
  await sansRechargement(admin);
});

test("chez un responsable aussi, la gestion se met à jour : la demande d'un nouveau membre arrive dans « À traiter »", async ({ browser }) => {
  const admin = await (await connecter(browser, ADMIN)).newPage();
  const responsable = personne("responsable");
  const pageResponsable = await (await connecter(browser, responsable)).newPage();
  const equipe = `Équipe rafraichissement ${suffixe}`;
  await nouvelleEquipe(admin, equipe);
  await designer(admin, responsable.uid);
  const pageEquipe = admin.url();
  await pageResponsable.clock.install();
  await pageResponsable.goto("/gestion/demandes");
  await marquer(pageResponsable);

  const demandeur = await nouvelleDemande(browser, "membre", equipe);
  await expect(ligneDeLaFile(pageResponsable, "À traiter", demandeur)).toHaveCount(0);
  await pageResponsable.clock.runFor(30_000);
  await expect(ligneDeLaFile(pageResponsable, "À traiter", demandeur)).toBeVisible();
  await sansRechargement(pageResponsable);

  // Nettoyage : la responsable refuse la demande, puis l'équipe est supprimée.
  await ligneDeLaFile(pageResponsable, "À traiter", demandeur).getByRole("link", { name: "Examiner" }).click();
  await refuser(pageResponsable, "Parcours terminé");
  await admin.goto(pageEquipe);
  await faireSortir(admin, responsable.uid);
  await supprimerEquipe(admin);
  await expect(admin.getByRole("status")).toHaveText("Équipe supprimée.");
});
