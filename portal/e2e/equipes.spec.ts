import { expect, type Page, test } from "@playwright/test";
import { ADMIN, ajouterAEquipe, ajouterMembre, appel, connecter, courriels, demanderEtApprouver, designer, echapper, enrichirModele, faireSortir, nouvelleEquipe, retirerCle, supprimerEquipe } from "./outils";

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

test("un admin crée puis renomme une équipe ; un nom déjà pris est refusé ; les salariés peuvent la rejoindre (ticket #36)", async ({ browser }) => {
  const admin = await (await connecter(browser, ADMIN)).newPage();
  await admin.goto("/gestion/demandes");
  await admin.getByRole("navigation", { name: "Administration" }).getByRole("link", { name: "Équipes" }).click();
  await expect(admin.getByRole("heading", { level: 1 })).toHaveText("Équipes");

  const nom = `Équipe essai ${suffixe}`;
  await admin.getByLabel("Nom de la nouvelle équipe").fill(nom);
  await admin.getByRole("button", { name: "Créer l'équipe" }).click();
  await expect(admin.getByRole("status")).toHaveText("Équipe créée.");
  await expect(admin.getByRole("row", { name: new RegExp(nom) }).getByRole("cell")).toHaveText([nom, "Aucun", "0", "0", "Sans limite"]);

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
    "Cette équipe a encore des clés actives (0) ou des demandes en cours (1) : révoquez ses clés, y compris celles créées depuis la console de LiteLLM, et traitez ses demandes avant de la supprimer.",
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

test("un admin désigne un responsable, qui devient membre ; le formulaire de demande dit qui validera ; le retrait du rôle le laisse membre (ticket #39)", async ({ browser }) => {
  const responsable = personne("responsable");
  const membre = personne("demandeur");
  const pageResponsable = await (await connecter(browser, responsable)).newPage();
  const pageMembre = await (await connecter(browser, membre)).newPage();
  const admin = await (await connecter(browser, ADMIN)).newPage();
  const nom = `Équipe responsables ${suffixe}`;
  await nouvelleEquipe(admin, nom);
  const responsables = admin.getByRole("region", { name: "Responsables" });
  await expect(responsables).toContainText("Aucun responsable : les administrateurs valident les demandes de l'équipe.");

  await admin.getByLabel("Uid du responsable").fill(responsable.uid);
  await admin.getByRole("button", { name: "Désigner responsable" }).click();
  await expect(admin.getByRole("status")).toHaveText("Responsable désigné.");
  await expect(responsables.getByRole("row", { name: new RegExp(responsable.uid) })).toContainText(responsable.email);
  await expect(admin.getByRole("region", { name: "Membres" }).getByRole("row", { name: new RegExp(responsable.uid) })).toBeVisible();
  await ajouterMembre(admin, membre.uid);
  await admin.goto("/gestion/equipes");
  await expect(admin.getByRole("row", { name: new RegExp(nom) }).getByRole("cell")).toHaveText([nom, responsable.uid, "2", "0", "Sans limite"]);

  // Le formulaire de demande dit qui validera, selon l'équipe choisie.
  await ajouterAEquipe(membre.uid, "R&D");
  await pageMembre.goto("/demandes/nouvelle");
  await pageMembre.getByLabel("Équipe").selectOption({ label: nom });
  await expect(pageMembre.getByText(`Votre demande sera validée par : ${responsable.uid}.`)).toBeVisible();
  await pageMembre.getByLabel("Équipe").selectOption({ label: "R&D" });
  await expect(pageMembre.getByText("Votre demande sera validée par les administrateurs.")).toBeVisible();
  // Le responsable ne valide pas ses propres demandes : elles iront aux administrateurs.
  await pageResponsable.goto("/demandes/nouvelle");
  await pageResponsable.getByLabel("Équipe").selectOption({ label: nom });
  await expect(pageResponsable.getByText("Votre demande sera validée par les administrateurs.")).toBeVisible();
  // Et en anglais.
  const anglais = await (await connecter(browser, membre, "en-US")).newPage();
  await anglais.goto("/demandes/nouvelle");
  await anglais.getByLabel("Team").selectOption({ label: nom });
  await expect(anglais.getByText(`Your request will be approved by: ${responsable.uid}.`)).toBeVisible();

  await expect.poll(async () => (await courriels(responsable.uid)).map((c) => c.subject), { timeout: 15_000 }).toContain(
    `[AI GATEWAY] Vous êtes responsable de l'équipe ${nom} / You are a manager of the team ${nom}`,
  );

  // Retrait du rôle : il reste membre.
  await admin.getByRole("link", { name: nom, exact: true }).click();
  await responsables.getByRole("row", { name: new RegExp(responsable.uid) }).getByRole("button", { name: "Retirer le rôle de responsable" }).click();
  await expect(admin.getByRole("status")).toHaveText("Rôle de responsable retiré.");
  await expect(responsables).toContainText("Aucun responsable");
  await expect(admin.getByRole("region", { name: "Membres" }).getByRole("row", { name: new RegExp(responsable.uid) })).toBeVisible();

  // Nettoyage.
  await faireSortir(admin, responsable.uid);
  await faireSortir(admin, membre.uid);
  await supprimerEquipe(admin);
  await expect(admin.getByRole("status")).toHaveText("Équipe supprimée.");
});

test("un responsable voit, dans une gestion limitée à son équipe, ses demandes, ses clés et ses membres ; le reste lui est introuvable (ticket #40)", async ({ browser }) => {
  const responsable = personne("gestionnaire");
  const membre = personne("equipier");
  const etranger = personne("etranger");
  const pageResponsable = await (await connecter(browser, responsable)).newPage();
  const pageMembre = await (await connecter(browser, membre)).newPage();
  const pageEtranger = await (await connecter(browser, etranger)).newPage();
  const admin = await (await connecter(browser, ADMIN)).newPage();
  const nom = `Équipe gestion ${suffixe}`;
  await nouvelleEquipe(admin, nom);
  await designer(admin, responsable.uid);
  await ajouterMembre(admin, membre.uid);
  const pageEquipe = admin.url();

  // Une demande dans l'équipe, une autre dans R&D, hors de l'autorité du responsable.
  await deposerDemande(pageMembre, nom, "Demande de l'équipe");
  await ajouterAEquipe(etranger.uid, "R&D");
  await deposerDemande(pageEtranger, "R&D", "Demande d'une autre équipe");

  // Un salarié sans rôle n'a pas de gestion.
  await pageMembre.goto("/");
  await expect(pageMembre.getByRole("link", { name: /^Gestion/ })).toHaveCount(0);
  expect((await pageMembre.goto("/gestion/demandes"))?.status()).toBe(404);

  // Le responsable : lien « Gestion » avec la pastille de son équipe, onglets limités.
  await pageResponsable.goto("/");
  await pageResponsable.getByRole("link", { name: "Gestion (1 demande à valider)" }).click();
  await expect(pageResponsable.getByRole("navigation", { name: "Administration" }).getByRole("link")).toHaveText([/^Demandes/, /^Clés/, "Équipes"]);
  await expect(pageResponsable.getByRole("table").first()).toContainText(membre.uid);
  await expect(pageResponsable.getByRole("main")).not.toContainText(etranger.uid);
  await pageResponsable.getByRole("row", { name: new RegExp(membre.uid) }).getByRole("link", { name: "Examiner" }).click();
  await expect(pageResponsable.getByRole("heading", { level: 1 })).toHaveText(`Clé d'API pour ${membre.uid}`);

  // Hors de son autorité : introuvable.
  await admin.goto("/gestion/demandes");
  const ficheEtrangere = await admin.getByRole("row", { name: new RegExp(etranger.uid) }).getByRole("link", { name: "Examiner" }).getAttribute("href");
  expect((await pageResponsable.goto(ficheEtrangere!))?.status()).toBe(404);
  for (const chemin of ["/gestion/catalogue", "/gestion/parametres", "/gestion/outils"]) {
    expect((await pageResponsable.goto(chemin))?.status(), chemin).toBe(404);
  }

  // Son équipe seulement, en lecture.
  await pageResponsable.goto("/gestion/equipes");
  await expect(pageResponsable.getByRole("button", { name: "Créer l'équipe" })).toHaveCount(0);
  await expect(pageResponsable.getByRole("row")).toHaveCount(2);
  await pageResponsable.getByRole("link", { name: nom, exact: true }).click();
  await expect(pageResponsable.getByRole("region", { name: "Membres" })).toContainText(membre.uid);
  await expect(pageResponsable.getByRole("button", { name: "Renommer" })).toHaveCount(0);
  await pageResponsable.goto("/gestion/cles");
  await expect(pageResponsable.getByRole("heading", { level: 1 })).toHaveText("Clés d'API");

  // La nouvelle demande a été annoncée au responsable et aux admins.
  await expect.poll(async () => (await courriels(membre.uid)).find((c) => c.subject.includes("Nouvelle demande de clé"))?.to, { timeout: 15_000 }).toEqual([
    "admins-e2e@example.org",
    responsable.email,
  ]);

  // Nettoyage.
  await admin.goto(pageEquipe);
  await faireSortir(admin, membre.uid);
  await faireSortir(admin, responsable.uid);
  await supprimerEquipe(admin);
  await expect(admin.getByRole("status")).toHaveText("Équipe supprimée.");
});

test("un responsable approuve la demande d'un membre de son équipe, qui retire sa clé ; sa propre demande part aux admins (ticket #41)", async ({ browser, request }) => {
  const responsable = personne("valideur");
  const membre = personne("titulaire");
  const pageResponsable = await (await connecter(browser, responsable)).newPage();
  const pageMembre = await (await connecter(browser, membre)).newPage();
  const admin = await (await connecter(browser, ADMIN)).newPage();
  const nom = `Équipe validation ${suffixe}`;
  await nouvelleEquipe(admin, nom);
  await designer(admin, responsable.uid);
  await ajouterMembre(admin, membre.uid);
  const pageEquipe = admin.url();
  await deposerDemande(pageMembre, nom, "Demande à valider par le responsable");

  // Le responsable approuve depuis sa gestion ; seules ses équipes lui sont proposées.
  await pageResponsable.goto("/gestion/demandes");
  await pageResponsable.getByRole("row", { name: new RegExp(membre.uid) }).getByRole("link", { name: "Examiner" }).click();
  await expect(pageResponsable.getByLabel("Équipe de la clé").locator("option")).toHaveText([nom]);
  await pageResponsable.getByLabel("Budget (€)").fill("5");
  await pageResponsable.getByLabel("Période du budget (ex. 30d)").fill("30d");
  await pageResponsable.getByLabel("Durée de validité").selectOption({ label: "1 mois" });
  await pageResponsable.getByRole("button", { name: "Approuver", exact: true }).click();
  await expect(pageResponsable.getByRole("status")).toHaveText("Demande approuvée.");

  // Le membre retire sa clé, qui fonctionne ; la décision est au nom du responsable, et les admins en sont prévenus.
  const cle = await retirerCle(pageMembre);
  expect(await appel(request, cle)).toBe(200);
  await pageResponsable.goto("/gestion/demandes");
  await expect(pageResponsable.getByRole("region", { name: /Archive/ }).getByRole("row", { name: new RegExp(membre.uid) })).toContainText(responsable.uid);
  await expect.poll(async () => (await courriels(membre.uid)).map((c) => c.subject), { timeout: 15_000 }).toContain(
    `[AI GATEWAY] Demande traitée dans l'équipe ${nom} : ${membre.uid} / Request processed in the team ${nom}: ${membre.uid}`,
  );

  // Sa propre demande : aucune décision possible ; elle ira aux administrateurs.
  await deposerDemande(pageResponsable, nom, "Demande du responsable");
  await pageResponsable.goto("/gestion/demandes");
  await pageResponsable.getByRole("row", { name: new RegExp(`${responsable.uid}.*Clé d'API`) }).getByRole("link", { name: "Examiner" }).click();
  await expect(pageResponsable.getByText("Vous ne pouvez pas décider de votre propre demande : un autre responsable de l'équipe ou un administrateur s'en chargera.")).toBeVisible();
  await expect(pageResponsable.getByRole("button", { name: "Approuver", exact: true })).toHaveCount(0);
  const fiche = pageResponsable.url();
  // L'admin, lui, la refuse.
  await admin.goto(fiche);
  await admin.getByLabel("Motif du refus").fill("Essai terminé");
  await admin.getByRole("button", { name: "Refuser" }).click();
  await expect(admin.getByRole("status")).toHaveText("Demande refusée.");

  // Nettoyage : la sortie du membre révoque sa clé, puis l'équipe se supprime.
  await admin.goto(pageEquipe);
  await faireSortir(admin, membre.uid);
  await faireSortir(admin, responsable.uid);
  await supprimerEquipe(admin);
  await expect(admin.getByRole("status")).toHaveText("Équipe supprimée.");
});

test("un responsable bloque, débloque et révoque la clé d'un membre de son équipe, puis le fait sortir de l'équipe (ticket #42)", async ({ browser, request }) => {
  const responsable = personne("gardien");
  const membre = personne("porteur");
  const pageResponsable = await (await connecter(browser, responsable)).newPage();
  const pageMembre = await (await connecter(browser, membre)).newPage();
  const admin = await (await connecter(browser, ADMIN)).newPage();
  const nom = `Équipe clés ${suffixe}`;
  await nouvelleEquipe(admin, nom);
  await designer(admin, responsable.uid);
  await ajouterMembre(admin, membre.uid);
  const pageEquipe = admin.url();
  await demanderEtApprouver(browser, pageMembre, membre, { equipe: nom, projet: "Essai gardien" });
  const cle = await retirerCle(pageMembre);
  expect(await appel(request, cle)).toBe(200);

  // Tant qu'elle a une clé active, l'équipe ne peut pas être supprimée : LiteLLM supprimerait la clé avec elle.
  await supprimerEquipe(admin);
  await expect(admin.getByRole("main").getByRole("alert")).toHaveText(
    "Cette équipe a encore des clés actives (1) ou des demandes en cours (0) : révoquez ses clés, y compris celles créées depuis la console de LiteLLM, et traitez ses demandes avant de la supprimer.",
  );
  // Le nombre de clés actives mène à la gestion des clés, limitée à l'équipe.
  await admin.getByRole("link", { name: "Voir la clé active de l'équipe" }).click();
  await expect(admin.getByText(`Clés de l'équipe ${nom}`)).toBeVisible();
  const clesActives = admin.getByRole("region", { name: "Clés actives" });
  await expect(clesActives.getByRole("row")).toHaveCount(2);
  await expect(clesActives.getByRole("row", { name: new RegExp(membre.uid) })).toBeVisible();
  await expect(admin.getByRole("link", { name: "Toutes les clés" })).toBeVisible();
  await admin.goto(pageEquipe);

  // Blocage puis déblocage depuis la gestion du responsable.
  await pageResponsable.goto("/gestion/cles");
  const ligne = () => pageResponsable.getByRole("region", { name: "Clés actives" }).getByRole("row", { name: new RegExp(membre.uid) });
  await ligne().getByRole("button", { name: "Bloquer" }).click();
  await expect(pageResponsable.getByRole("status")).toHaveText("Clé bloquée.");
  await expect.poll(() => appel(request, cle), { timeout: 15_000, intervals: [1_000] }).not.toBe(200);
  await ligne().getByRole("button", { name: "Débloquer" }).click();
  await expect(pageResponsable.getByRole("status")).toHaveText("Clé débloquée.");
  await expect.poll(() => appel(request, cle), { timeout: 15_000, intervals: [1_000] }).toBe(200);

  // Révocation : la passerelle refuse la clé ; le titulaire sait qu'un responsable de son équipe l'a révoquée.
  await ligne().getByText("Révoquer").click();
  await ligne().getByRole("button", { name: "Confirmer la révocation" }).click();
  await expect(pageResponsable.getByRole("status")).toHaveText("Clé révoquée.");
  await expect.poll(() => appel(request, cle), { timeout: 15_000, intervals: [1_000] }).toBe(401);
  await expect.poll(async () => (await courriels(membre.uid)).find((c) => c.subject.includes("a été révoquée"))?.text ?? "", { timeout: 15_000 }).toContain(
    "Un responsable de votre équipe a révoqué votre clé d'API",
  );

  // Le responsable fait sortir le membre de l'équipe ; pas lui-même, ce qui lui retirerait son rôle : c'est l'affaire d'un admin.
  await pageResponsable.goto(pageEquipe);
  await expect(pageResponsable.getByRole("region", { name: "Membres" }).getByRole("row", { name: new RegExp(responsable.uid) }).getByText("Faire sortir de l'équipe")).toHaveCount(0);
  await faireSortir(pageResponsable, membre.uid);
  await expect(pageResponsable.getByRole("region", { name: "Membres" })).not.toContainText(membre.uid);

  // Nettoyage.
  await admin.goto(pageEquipe);
  await faireSortir(admin, responsable.uid);
  await supprimerEquipe(admin);
  await expect(admin.getByRole("status")).toHaveText("Équipe supprimée.");
});

test("un admin fixe le budget d'une équipe, affiché avec la dépense de la période ; le responsable le voit sans pouvoir le changer ; 0 le retire (ticket #43)", async ({ browser, request }) => {
  const responsable = personne("tresorier");
  const membre = personne("depensier");
  const pageResponsable = await (await connecter(browser, responsable)).newPage();
  const pageMembre = await (await connecter(browser, membre)).newPage();
  const admin = await (await connecter(browser, ADMIN)).newPage();
  const nom = `Équipe budget ${suffixe}`;
  await nouvelleEquipe(admin, nom);
  await designer(admin, responsable.uid);
  await ajouterMembre(admin, membre.uid);
  const pageEquipe = admin.url();
  const budget = admin.getByRole("region", { name: "Budget d'équipe" });
  await expect(budget).toContainText("Sans limite");

  // Un budget positif sans période est refusé.
  await budget.getByLabel("Budget (€)").fill("50");
  await budget.getByRole("button", { name: "Enregistrer le budget" }).click();
  await expect(admin.getByRole("main").getByRole("alert")).toHaveText(
    "Budget d'équipe invalide : saisissez un montant positif ou nul (0 : sans limite) et, pour un montant positif, une période au format 30d, 12h…",
  );

  // 50 € par période de 30 jours : la page donne le budget, la dépense de la période et sa remise à zéro.
  await budget.getByLabel("Budget (€)").fill("50");
  await budget.getByLabel("Période du budget (ex. 30d)").fill("30d");
  await budget.getByRole("button", { name: "Enregistrer le budget" }).click();
  await expect(admin.getByRole("status")).toHaveText("Budget de l'équipe enregistré.");
  await expect(budget).toContainText(/50,00\s€ par période de 30 jours/);
  await expect(budget).toContainText(/Dépense de la période\s*0,00\s€ sur 50,00\s€/);
  await expect(budget).toContainText("Remise à zéro");

  // Les admins et le responsable de l'équipe en sont prévenus.
  const annonces = async () => (await courriels(suffixe)).filter((c) => c.subject.includes(`Budget de l'équipe ${nom}`));
  await expect.poll(async () => (await annonces()).length, { timeout: 15_000 }).toBe(1);
  const [annonce] = await annonces();
  expect(annonce.to).toEqual(["admins-e2e@example.org", responsable.email]);
  expect(annonce.subject).toMatch(new RegExp(`^\\[AI GATEWAY\\] Budget de l'équipe ${echapper(nom)} : 50,00\\s€ par période de 30 jours / Budget of the team ${echapper(nom)}: €50\\.00 every 30 days$`));

  // La dépense d'un appel d'un membre, comptée par la passerelle pour l'équipe, apparaît dans la liste des équipes.
  await demanderEtApprouver(browser, pageMembre, membre, { equipe: nom, projet: "Essai budget" });
  const cle = await retirerCle(pageMembre);
  expect(await appel(request, cle)).toBe(200);
  await expect(async () => {
    await admin.goto("/gestion/equipes");
    await expect(admin.getByRole("row", { name: new RegExp(echapper(nom)) }).getByRole("cell").last()).toHaveText(/^moins de 0,01\s€ sur 50,00\s€$/, { timeout: 1_000 });
  }).toPass({ timeout: 45_000 });

  // Le responsable voit le budget de son équipe, sans pouvoir le changer.
  await pageResponsable.goto(pageEquipe);
  const budgetVuDuResponsable = pageResponsable.getByRole("region", { name: "Budget d'équipe" });
  await expect(budgetVuDuResponsable).toContainText(/50,00\s€ par période de 30 jours/);
  await expect(budgetVuDuResponsable.getByRole("button", { name: "Enregistrer le budget" })).toHaveCount(0);

  // 0 retire le plafond.
  await admin.goto(pageEquipe);
  await budget.getByLabel("Budget (€)").fill("0");
  await budget.getByRole("button", { name: "Enregistrer le budget" }).click();
  await expect(admin.getByRole("status")).toHaveText("Budget de l'équipe enregistré.");
  await expect(budget).toContainText("Sans limite");
  await expect(budget).not.toContainText("Dépense de la période");
  await expect.poll(async () => (await annonces()).map((c) => c.subject), { timeout: 15_000 }).toContain(
    `[AI GATEWAY] Budget de l'équipe ${nom} : sans limite / Budget of the team ${nom}: no limit`,
  );

  // Nettoyage : la sortie du membre révoque sa clé, puis l'équipe se supprime.
  await faireSortir(admin, membre.uid);
  await faireSortir(admin, responsable.uid);
  await supprimerEquipe(admin);
  await expect(admin.getByRole("status")).toHaveText("Équipe supprimée.");
});
