import { expect, type Page, test } from "@playwright/test";
import { ADMIN, appel, connecter, courriels, demanderEtApprouver, enrichirModele, retirerCle } from "./outils";

/* Gestion des équipes par les admins et responsables d'équipe (spécification #35). Admins à notifier : admins-e2e@example.org (.env). */
const suffixe = Date.now().toString(36);
const personne = (n: string) => ({ uid: `equipes-${n}-${suffixe}`, email: `equipes-${n}-${suffixe}@example.org`, name: `Personne ${n} ${suffixe}` });

test.beforeAll(async ({ browser }) => {
  const context = await connecter(browser, ADMIN);
  await enrichirModele(await context.newPage(), { nom: "dev-public", nomAffiche: "Modèle public", niveau: "N1" });
  await context.close();
});

/** Le salarié (page ouverte) dépose une demande de clé N1 pour le modèle public dans une équipe dont il est membre. */
async function deposerDemande(page: Page, equipe: string, motif: string): Promise<void> {
  await page.goto("/demandes/nouvelle");
  await page.getByLabel("Équipe").selectOption({ label: equipe });
  await page.getByRole("radio", { name: /^N1 Public/ }).check();
  await page.getByLabel(/Modèle public/).check();
  await page.getByLabel("Motif").fill(motif);
  await page.getByLabel(/Je m'engage/).check();
  await page.getByRole("button", { name: "Envoyer la demande" }).click();
  await expect(page.getByRole("status")).toHaveText("Demande envoyée aux administrateurs.");
}

/** Sur la page d'une équipe, l'admin fait sortir un membre, avec confirmation. */
async function faireSortir(admin: Page, uid: string): Promise<void> {
  const ligne = admin.getByRole("region", { name: "Membres" }).getByRole("row", { name: new RegExp(uid) });
  await ligne.getByText("Faire sortir de l'équipe").click();
  await ligne.getByRole("button", { name: "Confirmer la sortie" }).click();
  await expect(admin.getByRole("status")).toHaveText("Le membre est sorti de l'équipe : ses clés de l'équipe sont révoquées.");
}

/** Sur la page d'une équipe, l'admin demande sa suppression, avec confirmation. */
async function supprimerEquipe(admin: Page): Promise<void> {
  const zone = admin.getByRole("region", { name: "Suppression de l'équipe" });
  await zone.getByText("Supprimer l'équipe").click();
  await zone.getByRole("button", { name: "Confirmer la suppression" }).click();
}

/** Un admin crée une équipe au nom unique et ouvre sa page. */
async function nouvelleEquipe(admin: Page, nom: string): Promise<void> {
  await admin.goto("/gestion/equipes");
  await admin.getByLabel("Nom de la nouvelle équipe").fill(nom);
  await admin.getByRole("button", { name: "Créer l'équipe" }).click();
  await expect(admin.getByRole("status")).toHaveText("Équipe créée.");
  await admin.getByRole("link", { name: nom, exact: true }).click();
  await expect(admin.getByRole("heading", { level: 1 })).toHaveText(nom);
}

test("un admin crée puis renomme une équipe ; un nom déjà pris est refusé ; les salariés peuvent la rejoindre (ticket #36)", async ({ browser }) => {
  const admin = await (await connecter(browser, ADMIN)).newPage();
  await admin.goto("/gestion/demandes");
  await admin.getByRole("navigation", { name: "Administration" }).getByRole("link", { name: "Équipes" }).click();
  await expect(admin.getByRole("heading", { level: 1 })).toHaveText("Équipes");

  const nom = `Équipe essai ${suffixe}`;
  await admin.getByLabel("Nom de la nouvelle équipe").fill(nom);
  await admin.getByRole("button", { name: "Créer l'équipe" }).click();
  await expect(admin.getByRole("status")).toHaveText("Équipe créée.");
  await expect(admin.getByRole("row", { name: new RegExp(nom) }).getByRole("cell")).toHaveText([nom, "0", "0"]);

  // Un nom déjà pris, même avec d'autres majuscules, est refusé.
  await admin.getByLabel("Nom de la nouvelle équipe").fill(nom.toUpperCase());
  await admin.getByRole("button", { name: "Créer l'équipe" }).click();
  await expect(admin.getByRole("main").getByRole("alert")).toHaveText(`Le nom ${nom} est déjà pris par une autre équipe.`);

  // Renommage depuis la page de l'équipe.
  await admin.getByRole("link", { name: nom, exact: true }).click();
  await expect(admin.getByRole("heading", { level: 1 })).toHaveText(nom);
  const nouveauNom = `Équipe renommée ${suffixe}`;
  await admin.getByLabel("Nom de l'équipe").fill(nouveauNom);
  await admin.getByRole("button", { name: "Renommer" }).click();
  await expect(admin.getByRole("status")).toHaveText("Équipe renommée.");
  await expect(admin.getByRole("heading", { level: 1 })).toHaveText(nouveauNom);

  // Les admins sont prévenus de la création et du renommage.
  await expect.poll(async () => (await courriels(suffixe)).map((c) => c.subject).sort(), { timeout: 15_000 }).toEqual([
    `[AI GATEWAY] Équipe créée : ${nom} / Team created: ${nom}`,
    `[AI GATEWAY] Équipe renommée : ${nouveauNom} / Team renamed: ${nouveauNom}`,
  ]);
  expect((await courriels(suffixe))[0].to).toEqual(["admins-e2e@example.org"]);

  // La nouvelle équipe est proposée aux salariés qui veulent la rejoindre.
  const salarie = await (await connecter(browser, personne("adhesion"))).newPage();
  await salarie.goto("/demandes/adhesion");
  await expect(salarie.getByLabel("Équipe").locator("option", { hasText: nouveauNom })).toHaveCount(1);
  // La gestion des équipes est réservée aux admins.
  expect((await salarie.goto("/gestion/equipes"))?.status()).toBe(404);

  // Sans membre ni demande, l'équipe d'essai se supprime.
  await supprimerEquipe(admin);
  await expect(admin.getByRole("status")).toHaveText("Équipe supprimée.");
});

test("un admin ajoute directement un salarié à une équipe, puis l'en fait sortir : sa clé de l'équipe est révoquée et refusée par la passerelle (ticket #37)", async ({ browser, request }) => {
  const salarie = personne("membre");
  const page = await (await connecter(browser, salarie)).newPage();
  const admin = await (await connecter(browser, ADMIN)).newPage();
  const nom = `Équipe membres ${suffixe}`;
  await nouvelleEquipe(admin, nom);
  const membres = admin.getByRole("region", { name: "Membres" });
  await expect(membres).toContainText("Aucun membre.");

  // Un uid qui ne s'est jamais connecté au portail est refusé.
  await admin.getByLabel("Uid du salarié").fill(`inconnu-${suffixe}`);
  await admin.getByRole("button", { name: "Ajouter à l'équipe" }).click();
  await expect(admin.getByRole("main").getByRole("alert")).toHaveText(`Aucun salarié ne s'est encore connecté au portail avec l'identifiant inconnu-${suffixe}.`);

  // Ajout direct : le salarié devient membre, et peut aussitôt demander une clé pour l'équipe.
  await admin.getByLabel("Uid du salarié").fill(salarie.uid);
  await admin.getByRole("button", { name: "Ajouter à l'équipe" }).click();
  await expect(admin.getByRole("status")).toHaveText("Membre ajouté.");
  await expect(membres.getByRole("row", { name: new RegExp(salarie.uid) })).toBeVisible();
  await demanderEtApprouver(browser, page, salarie, { equipe: nom, projet: "Essai sortie" });
  const cle = await retirerCle(page);
  expect(await appel(request, cle)).toBe(200);
  // Une seconde demande reste en cours dans l'équipe.
  await deposerDemande(page, nom, "Seconde demande");

  // Sortie de l'équipe : la clé est révoquée, la demande en cours annulée.
  await admin.reload();
  await faireSortir(admin, salarie.uid);
  await expect(membres).toContainText("Aucun membre.");
  await expect.poll(() => appel(request, cle), { timeout: 15_000, intervals: [1_000] }).toBe(401);
  await page.goto("/demandes");
  await expect(page.getByRole("row", { name: /Clé d'API.*Annulée/ })).toHaveCount(1);
  await page.goto("/cles");
  await expect(page.getByRole("region", { name: "Clés émises" }).getByRole("article").first()).toContainText("Révoquée");

  // Le salarié est prévenu de son ajout et de sa sortie.
  await expect.poll(async () => (await courriels(salarie.uid)).filter((c) => c.to.includes(salarie.email)).map((c) => c.subject).sort(), { timeout: 15_000 }).toEqual(
    expect.arrayContaining([
      `[AI GATEWAY] Vous êtes membre de l'équipe ${nom} / You are a member of the team ${nom}`,
      `[AI GATEWAY] Vous ne faites plus partie de l'équipe ${nom} / You are no longer a member of the team ${nom}`,
    ]),
  );
  await supprimerEquipe(admin);
  await expect(admin.getByRole("status")).toHaveText("Équipe supprimée.");
});

test("une équipe qui a une demande en cours ne peut pas être supprimée ; vide, elle disparaît et l'historique garde son nom (ticket #38)", async ({ browser }) => {
  const salarie = personne("suppression");
  const page = await (await connecter(browser, salarie)).newPage();
  const admin = await (await connecter(browser, ADMIN)).newPage();
  const nom = `Équipe suppression ${suffixe}`;
  await nouvelleEquipe(admin, nom);
  await admin.getByLabel("Uid du salarié").fill(salarie.uid);
  await admin.getByRole("button", { name: "Ajouter à l'équipe" }).click();
  await expect(admin.getByRole("status")).toHaveText("Membre ajouté.");
  await deposerDemande(page, nom, "Demande en cours");

  // Refus : la demande est encore en cours.
  await admin.reload();
  await supprimerEquipe(admin);
  await expect(admin.getByRole("main").getByRole("alert")).toHaveText(
    "Cette équipe a encore des clés actives (0) ou des demandes en cours (1) : révoquez ses clés et traitez ses demandes avant de la supprimer.",
  );

  // Après la sortie du membre (sa demande est annulée), l'équipe se supprime.
  await faireSortir(admin, salarie.uid);
  await supprimerEquipe(admin);
  await expect(admin.getByRole("status")).toHaveText("Équipe supprimée.");
  await expect(admin).toHaveURL(/\/gestion\/equipes\?/);
  await expect(admin.getByRole("link", { name: nom, exact: true })).toHaveCount(0);
  await expect.poll(async () => (await courriels(suffixe)).map((c) => c.subject), { timeout: 15_000 }).toContain(`[AI GATEWAY] Équipe supprimée : ${nom} / Team deleted: ${nom}`);

  // L'historique du salarié garde le nom de l'équipe.
  await page.goto("/demandes");
  await expect(page.getByRole("row", { name: new RegExp(`Clé d'API.*${nom}.*Annulée`) })).toHaveCount(1);
});
