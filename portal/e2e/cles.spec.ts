import { expect, test } from "@playwright/test";
import { ADMIN, ajouterAEquipe, appel, connecter, demandeApprouvee, enrichirModele, PASSERELLE, retirerCle } from "./outils";

/* Chantier « Mes clés » (spécification #14). La passerelle de développement répond par des modèles simulés. */
const suffixe = Date.now().toString(36);
const personne = (n: string) => ({ uid: `cles-${n}-${suffixe}`, email: `cles-${n}-${suffixe}@example.org`, name: `Personne ${n} ${suffixe}` });

test.beforeAll(async ({ browser }) => {
  const context = await connecter(browser, ADMIN);
  const page = await context.newPage();
  await enrichirModele(page, { nom: "dev-public", nomAffiche: "Modèle public", niveau: "N1" });
  // Délai de retrait de 14 jours, comme en production ; les autres valeurs par défaut restent inchangées.
  await page.goto("/gestion/parametres");
  await page.getByLabel("Délai de retrait d'une clé approuvée (jours)").fill("14");
  await page.getByRole("button", { name: "Enregistrer" }).click();
  await expect(page.getByRole("status")).toHaveText("Paramètres enregistrés.");
  await context.close();
});

test("le titulaire retire sa clé, la voit une seule fois, et elle fonctionne auprès de la passerelle (ticket #15)", async ({ browser, request }) => {
  const salarie = personne("retrait");
  const page = await (await connecter(browser, salarie)).newPage();
  await demandeApprouvee(browser, page, salarie, "Essai retrait");

  await page.goto("/demandes");
  // Une pastille du menu signale la clé approuvée à retirer.
  await expect(page.getByRole("link", { name: /^Mes clés \(1 clé à retirer\)$/ })).toBeVisible();
  await page.getByRole("row", { name: /Clé d'API.*Approuvée/ }).getByRole("link", { name: "Retirer ma clé" }).click();
  await expect(page).toHaveURL(/\/cles$/);
  const aRetirer = page.getByRole("region", { name: "À retirer" });
  await expect(aRetirer).toContainText(/À retirer avant le \d{2}\/\d{2}\/\d{4}/);
  await aRetirer.getByRole("button", { name: "Générer ma clé" }).click();

  const panneau = page.getByRole("region", { name: /Votre nouvelle clé/ });
  await expect(panneau).toContainText("elle ne sera plus jamais affichée");
  const cle = ((await panneau.locator("code").textContent()) ?? "").trim();
  expect(cle).toMatch(/^sk-/);
  const reponse = await request.post(PASSERELLE, { headers: { Authorization: `Bearer ${cle}` }, data: { model: "dev-public", messages: [{ role: "user", content: "Bonjour" }] } });
  expect(reponse.status()).toBe(200);

  await panneau.getByRole("button", { name: "J'ai copié ma clé" }).click();
  await expect(panneau).toHaveCount(0);
  const carte = page.getByRole("region", { name: "Clés émises" }).getByRole("article", { name: new RegExp(`^${salarie.uid}-r-d-essai-retrait-`) });
  await expect(carte).toContainText("Clé émise");
  await page.reload();
  expect(await page.content()).not.toContain(cle);
  await expect(page.getByRole("link", { name: "Mes clés", exact: true })).toBeVisible();
  // La carte donne l'adresse de l'API (endpoint), celle des exemples d'appel.
  await expect(carte).toContainText("Adresse de l'API");
  await expect(carte).toContainText("http://127.0.0.1:54400/admin/v1");
  // Le bouton de copie est centré verticalement sur l'adresse.
  const [adresse, copier] = await Promise.all([carte.locator("dd code").first().boundingBox(), carte.getByRole("button", { name: "Copier l'adresse" }).boundingBox()]);
  expect(Math.abs(adresse!.y + adresse!.height / 2 - (copier!.y + copier!.height / 2))).toBeLessThanOrEqual(2);

  // Ticket #16 : la dépense de l'appel apparaît (LiteLLM la compte en quelques secondes), avec le budget approuvé.
  await expect(async () => {
    await page.reload();
    await expect(carte).toContainText("moins de 0,01 € sur 5,00 €", { timeout: 1_000 });
  }).toPass({ timeout: 45_000 });
  await expect(carte).toContainText("Remise à zéro du budget");
  await carte.getByText("Comment l'utiliser").click();
  await expect(carte.locator("pre").first()).toContainText('"model": "dev-public"');
  await expect(carte).toContainText('model="dev-public"');
  expect(await carte.textContent()).not.toContain(cle);
});

/** Retire la clé de la seule demande approuvée du salarié ; rend la clé affichée une fois. */
test("le titulaire révoque sa clé : la passerelle la refuse en quelques secondes (ticket #17)", async ({ browser, request }) => {
  const salarie = personne("revocation");
  const page = await (await connecter(browser, salarie)).newPage();
  await demandeApprouvee(browser, page, salarie, "Essai revocation");
  const cle = await retirerCle(page);
  expect(await appel(request, cle)).toBe(200);

  const carte = page.getByRole("article", { name: new RegExp(`^${salarie.uid}-r-d-essai-revocation-`) });
  await carte.getByText("Révoquer cette clé").click();
  await carte.getByRole("button", { name: "Confirmer la révocation" }).click();
  await expect(page.getByRole("status")).toHaveText("Clé révoquée.");
  await expect(carte).toContainText("Révoquée");
  await expect(carte.getByText("Révoquer cette clé")).toHaveCount(0);
  await expect.poll(() => appel(request, cle), { timeout: 15_000, intervals: [1_000] }).toBe(401);
});

test("le titulaire remplace une clé perdue : même expiration, nouvel alias, l'ancienne est refusée (ticket #18)", async ({ browser, request }) => {
  const salarie = personne("remplacement");
  const page = await (await connecter(browser, salarie)).newPage();
  await demandeApprouvee(browser, page, salarie, "Essai remplacement");
  const ancienne = await retirerCle(page);
  const carte = page.getByRole("region", { name: "Clés émises" }).getByRole("article");
  const expiration = await carte.locator("dt", { hasText: "Expire le" }).locator("xpath=following-sibling::dd[1]").textContent();

  await carte.getByText("Remplacer ma clé (clé perdue)").click();
  await carte.getByRole("button", { name: "Générer la clé de remplacement" }).click();
  const panneau = page.getByRole("region", { name: /Votre nouvelle clé .*-2$/ });
  const nouvelle = ((await panneau.locator("code").textContent()) ?? "").trim();
  expect(nouvelle).toMatch(/^sk-/);
  expect(nouvelle).not.toBe(ancienne);
  await panneau.getByRole("button", { name: "J'ai copié ma clé" }).click();

  await expect(page.getByRole("article", { name: new RegExp(`^${salarie.uid}-r-d-essai-remplacement-.*-2$`) })).toBeVisible();
  await expect(carte.locator("dt", { hasText: "Expire le" }).locator("xpath=following-sibling::dd[1]")).toHaveText(expiration ?? "");
  expect(await appel(request, nouvelle)).toBe(200);
  await expect.poll(() => appel(request, ancienne), { timeout: 15_000, intervals: [1_000] }).toBe(401);
});

test("un admin voit toutes les clés émises et révoque celle d'un salarié (ticket #19)", async ({ browser, request }) => {
  const salarie = personne("gestion");
  const page = await (await connecter(browser, salarie)).newPage();
  await demandeApprouvee(browser, page, salarie, "Essai gestion");
  const cle = await retirerCle(page);

  const admin = await (await connecter(browser, ADMIN)).newPage();
  await admin.goto("/gestion/demandes");
  await admin.getByRole("navigation", { name: "Administration" }).getByRole("link", { name: /^Clés/ }).click();
  await expect(admin.getByRole("heading", { level: 1 })).toHaveText("Clés d'API");
  const ligne = admin.getByRole("row", { name: new RegExp(`${salarie.uid}.*${salarie.uid}-r-d-essai-gestion-.*R&D.*N1 Public.*sur 5,00 €.*Clé émise`) });
  await ligne.getByText("Révoquer").click();
  await ligne.getByRole("button", { name: "Confirmer la révocation" }).click();
  await expect(admin.getByRole("status")).toHaveText("Clé révoquée.");
  await expect(admin.getByRole("row", { name: new RegExp(`${salarie.uid}-r-d-essai-gestion-.*Révoquée`) })).toBeVisible();
  await expect.poll(() => appel(request, cle), { timeout: 15_000, intervals: [1_000] }).toBe(401);
  // L'archive des clés se lit page par page ; une page hors limites mène à la dernière.
  const pagination = admin.getByRole("region", { name: "Archive : clés révoquées ou expirées" }).getByRole("navigation", { name: "Pages de l'archive des clés" });
  await expect(pagination).toContainText(/^Page 1 sur \d+ \(\d+ clés? archivées?\)/);
  const pages = Number(/sur (\d+)/.exec((await pagination.textContent()) ?? "")?.[1]);
  await admin.goto("/gestion/cles?page=999");
  await expect(pagination).toContainText(`Page ${pages} sur ${pages}`);

  await page.goto("/cles");
  await expect(page.getByRole("article")).toContainText("Révoquée");
});

test("un admin bloque une clé, que la passerelle refuse et que le titulaire ne peut plus remplacer, puis la débloque (ticket #20)", async ({ browser, request }) => {
  const salarie = personne("blocage");
  const page = await (await connecter(browser, salarie)).newPage();
  await demandeApprouvee(browser, page, salarie, "Essai blocage");
  const cle = await retirerCle(page);

  const admin = await (await connecter(browser, ADMIN)).newPage();
  await admin.goto("/gestion/cles");
  const ligne = () => admin.getByRole("row", { name: new RegExp(`${salarie.uid}-r-d-essai-blocage-`) });
  await ligne().getByRole("button", { name: "Bloquer" }).click();
  await expect(admin.getByRole("status")).toHaveText("Clé bloquée.");
  await expect(ligne()).toContainText("bloquée");
  await expect.poll(() => appel(request, cle), { timeout: 15_000, intervals: [1_000] }).not.toBe(200);

  await page.goto("/cles");
  await expect(page.getByRole("article")).toContainText("Clé émise · bloquée");
  await expect(page.getByText("Remplacer ma clé (clé perdue)")).toHaveCount(0);

  await ligne().getByRole("button", { name: "Débloquer" }).click();
  await expect(admin.getByRole("status")).toHaveText("Clé débloquée.");
  await expect.poll(() => appel(request, cle), { timeout: 15_000, intervals: [1_000] }).toBe(200);
});

test("le titulaire renouvelle sa clé : demande préremplie, validée, et l'ancienne clé est révoquée au retrait de la nouvelle (ticket #21)", async ({ browser, request }) => {
  const salarie = personne("renouvellement");
  const page = await (await connecter(browser, salarie)).newPage();
  await demandeApprouvee(browser, page, salarie, "Essai renouvellement");
  const ancienne = await retirerCle(page);
  const origine = page.getByRole("article", { name: new RegExp(`^${salarie.uid}-r-d-essai-renouvellement-`) });
  const alias = ((await origine.locator("h3").textContent()) ?? "").trim();

  await origine.getByRole("link", { name: "Renouveler" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(`Renouveler la clé ${alias}`);
  await expect(page.getByRole("radio", { name: /^N1 Public/ })).toBeChecked();
  await expect(page.getByLabel(/Modèle public/)).toBeChecked();
  await expect(page.getByLabel("Projet ou affaire")).toHaveValue("Essai renouvellement");
  await page.getByLabel("Motif").fill("Renouvellement");
  await page.getByLabel(/Je m'engage/).check();
  await page.getByRole("button", { name: "Envoyer la demande" }).click();
  await expect(page.getByRole("status")).toHaveText("Demande envoyée aux administrateurs.");

  const admin = await (await connecter(browser, ADMIN)).newPage();
  await admin.goto("/gestion/demandes");
  await admin.getByRole("row", { name: new RegExp(`${salarie.uid}.*Clé d'API`) }).getByRole("link", { name: "Examiner" }).click();
  await expect(admin.getByRole("main")).toContainText(`Renouvellement de la clé ${alias}.`);
  await admin.getByRole("button", { name: "Approuver", exact: true }).click();
  await expect(admin.getByRole("status")).toHaveText("Demande approuvée.");

  const nouvelle = await retirerCle(page);
  expect(await appel(request, nouvelle)).toBe(200);
  await expect(page.getByRole("article", { name: alias })).toContainText("Révoquée");
  await expect.poll(() => appel(request, ancienne), { timeout: 15_000, intervals: [1_000] }).toBe(401);
});

test("la durée se choisit dans une liste ; une clé qui n'expire jamais l'indique dans « Mes clés »", async ({ browser, request }) => {
  const salarie = personne("sans-expiration");
  const page = await (await connecter(browser, salarie)).newPage();
  await ajouterAEquipe(salarie.uid, "R&D");
  await page.goto("/demandes/nouvelle");
  const duree = page.getByLabel("Durée souhaitée");
  await expect(duree.locator("option")).toHaveText(["24 heures", "1 semaine", "1 mois", "3 mois", "6 mois", "1 an", "N'expire jamais"]);
  await page.getByLabel("Équipe").selectOption({ label: "R&D" });
  await page.getByRole("radio", { name: /^N1 Public/ }).check();
  await page.getByLabel(/Modèle public/).check();
  await page.getByLabel("Motif").fill("Intégration continue");
  await duree.selectOption({ label: "N'expire jamais" });
  await page.getByLabel(/Je m'engage/).check();
  await page.getByRole("button", { name: "Envoyer la demande" }).click();
  await expect(page.getByRole("status")).toHaveText("Demande envoyée aux administrateurs.");

  const admin = await (await connecter(browser, ADMIN)).newPage();
  await admin.goto("/gestion/demandes");
  await admin.getByRole("row", { name: new RegExp(`${salarie.uid}.*Clé d'API`) }).getByRole("link", { name: "Examiner" }).click();
  await expect(admin.getByLabel("Durée de validité")).toHaveValue("0");
  await admin.getByLabel("Budget (€)").fill("5");
  await admin.getByLabel("Période du budget (ex. 30d)").fill("30d");
  await admin.getByRole("button", { name: "Approuver", exact: true }).click();
  await expect(admin.getByRole("status")).toHaveText("Demande approuvée.");
  await admin.context().close();

  const cle = await retirerCle(page);
  const carte = page.getByRole("article", { name: new RegExp(`^${salarie.uid}-r-d-cle-`) });
  await expect(carte).toContainText("N'expire jamais");
  expect(await appel(request, cle)).toBe(200);
});

test("« Mes clés » vide explique, étape par étape, comment obtenir une clé", async ({ browser }) => {
  const page = await (await connecter(browser, personne("debutant"))).newPage();
  await page.goto("/cles");
  const etapes = page.getByRole("main").getByRole("listitem");
  await expect(etapes).toHaveCount(4);
  await expect(etapes.nth(0).getByRole("link", { name: "Demander à rejoindre une équipe" })).toHaveAttribute("href", "/demandes/adhesion");
  await expect(etapes.nth(1).getByRole("link", { name: "Faire une demande de clé" })).toHaveAttribute("href", "/demandes/nouvelle");
  await expect(etapes.nth(2).getByRole("link", { name: "Suivre mes demandes" })).toHaveAttribute("href", "/demandes");
  await expect(etapes.nth(3)).toContainText("elle ne s'affiche qu'une seule fois");
});

test("« Mes clés » s'affiche en anglais", async ({ browser }) => {
  const page = await (await connecter(browser, personne("anglais"), "en-US")).newPage();
  await page.goto("/cles");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("My keys");
  await expect(page.getByRole("navigation").getByRole("link", { name: "My keys" })).toBeVisible();
  await expect(page.getByRole("main")).toContainText("You have no key yet");
});
