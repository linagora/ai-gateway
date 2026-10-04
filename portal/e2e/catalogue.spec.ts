import { expect, type Page, test } from "@playwright/test";
import { ADMIN, ajouterAEquipe, connecter, enrichirModele } from "./outils";

/* Catalogue des salariés (spécification #1). */
const suffixe = Date.now().toString(36);
const salarie = { uid: `catalogue-${suffixe}`, email: `catalogue-${suffixe}@example.org`, name: `Salarié ${suffixe}` };

test.beforeAll(async ({ browser }) => {
  const context = await connecter(browser, ADMIN);
  const page = await context.newPage();
  for (const modele of [
    { nom: "dev-public", nomAffiche: "Modèle public", niveau: "N1", casUsage: ["Extraction et automatisation"], recommandePour: ["Extraction et automatisation"] },
    { nom: "dev-interne", nomAffiche: "Modèle interne", niveau: "N2", casUsage: ["Rédaction et analyse", "Code"], recommandePour: ["Code"] },
    { nom: "dev-confidentiel", nomAffiche: "Modèle confidentiel", niveau: "N3", casUsage: ["Rédaction et analyse"], recommandePour: ["Rédaction et analyse"] },
    { nom: "dev-experimental", nomAffiche: "Modèle expérimental", niveau: "EXP", casUsage: [], recommandePour: [] },
    { nom: "dev-image", nomAffiche: "Modèle graphique", niveau: "N1", casUsage: ["Création d'images"], recommandePour: ["Création d'images"] },
    { nom: "dev-embeddings", nomAffiche: "Modèle vectoriel", niveau: "N3", casUsage: ["Extraction et automatisation"], recommandePour: [] },
  ]) {
    await enrichirModele(page, modele);
  }
  await context.close();
  // Le salarié existe dans LiteLLM après sa première connexion ; il rejoint l'équipe R&D de démonstration.
  await (await connecter(browser, salarie)).close();
  await ajouterAEquipe(salarie.uid, "R&D");
});

test("le catalogue montre l'éditeur et la zone d'exécution, jamais le fournisseur « openai » (ticket #3)", async ({ browser }) => {
  const context = await connecter(browser, salarie);
  const page = await context.newPage();
  await page.goto("/catalogue/n1");
  await expect(page.getByRole("article", { name: "Modèle interne" })).toContainText("Mistral AI · UE");
  await expect(page.getByRole("article", { name: "Modèle public" })).toContainText("Moonshot AI · Hors UE");
  await expect(page.getByRole("main")).not.toContainText("openai");
  await context.close();
});

test("l'admin complète une fiche en anglais, coche ses cas d'usage et voit les faits techniques (ticket #6)", async ({ browser }) => {
  const context = await connecter(browser, ADMIN);
  const page = await context.newPage();
  await page.goto("/gestion/catalogue");
  const fiche = () => page.locator("section").filter({ has: page.locator("code", { hasText: /^dev-confidentiel$/ }) });
  await expect(fiche()).toContainText("Alibaba (Qwen)");
  await expect(fiche()).toContainText("OVHcloud");
  await fiche().getByLabel("Nom affiché (anglais)").fill("Confidential model");
  await fiche().getByRole("group", { name: "Cas d'usage" }).getByLabel("Rédaction et analyse").check();
  await fiche().getByRole("group", { name: "Recommandé pour" }).getByLabel("Rédaction et analyse").check();
  await fiche().getByRole("button", { name: "Enregistrer" }).click();
  await expect(page.getByRole("status")).toHaveText("Catalogue mis à jour.");
  await expect(fiche().getByLabel("Nom affiché (anglais)")).toHaveValue("Confidential model");
  await expect(fiche().getByRole("group", { name: "Recommandé pour" }).getByLabel("Rédaction et analyse")).toBeChecked();

  // Une recommandation pour un cas d'usage non coché est refusée.
  await fiche().getByRole("group", { name: "Recommandé pour" }).getByLabel("Code").check();
  await fiche().getByRole("button", { name: "Enregistrer" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("cas d'usage coché");
  await context.close();

  const anglais = await connecter(browser, ADMIN, "en-US");
  const pageEn = await anglais.newPage();
  await pageEn.goto("/gestion/catalogue");
  const ficheEn = pageEn.locator("section").filter({ has: pageEn.locator("code", { hasText: /^dev-confidentiel$/ }) });
  await expect(ficheEn.getByLabel("Display name (English)")).toHaveValue("Confidential model");
  await ficheEn.getByRole("button", { name: "Save" }).click();
  await expect(pageEn.getByRole("status")).toHaveText("Catalog updated.");
  await anglais.close();
});

test("une saisie invalide nomme les champs en cause dans la langue de l'admin (ticket #6)", async ({ browser }) => {
  for (const [langue, libelle, enregistrer] of [
    ["fr-FR", "Nom affiché (français)", "Enregistrer"],
    ["en-US", "Display name (French)", "Save"],
  ]) {
    const context = await connecter(browser, ADMIN, langue);
    const page = await context.newPage();
    await page.goto("/gestion/catalogue");
    const fiche = page.locator("section").filter({ has: page.locator("code", { hasText: /^dev-experimental$/ }) });
    // Des espaces passent le contrôle du navigateur, pas celui du serveur.
    await fiche.getByLabel(libelle).fill("   ");
    await fiche.getByRole("button", { name: enregistrer }).click();
    const alerte = page.getByRole("main").getByRole("alert");
    await expect(alerte).toContainText(libelle);
    await expect(alerte).not.toContainText("displayNameFr");
    await context.close();
  }
});

test.describe("vue d'ensemble des niveaux (ticket #5)", () => {
  const carte = (page: Page, nom: string) => page.getByRole("region", { name: nom });

  test("les quatre niveaux s'affichent en français et en anglais", async ({ browser }) => {
    const context = await connecter(browser, salarie);
    const page = await context.newPage();
    await page.goto("/catalogue");
    for (const nom of ["N1 Public", "N2 Interne", "N3 Confidentiel", "Expérimental (bêta)"]) {
      await expect(carte(page, nom)).toContainText("Vous pouvez y confier");
      await expect(carte(page, nom)).toContainText("Jamais");
    }
    await context.close();
    const anglais = await connecter(browser, salarie, "en-US");
    const pageEn = await anglais.newPage();
    await pageEn.goto("/catalogue");
    for (const nom of ["N1 Public", "N2 Internal", "N3 Confidential", "Experimental (beta)"]) {
      await expect(carte(pageEn, nom)).toContainText("You may entrust");
    }
    await anglais.close();
  });

  test("les quatre cartes tiennent à l'écran sans défilement, sur une même rangée (écran de 1440 × 900), en français et en anglais", async ({ browser }) => {
    for (const langue of ["fr-FR", "en-US"]) {
      const context = await connecter(browser, salarie, langue);
      const page = await context.newPage();
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto("/catalogue");
      // Les cartes des niveaux ; l'entrée « Abonnements », dessous, peut dépasser l'écran.
      const cartes = page.getByRole("main").getByRole("region", { name: /^(N[123] |Exp)/ });
      await expect(cartes).toHaveCount(4);
      const boites = await cartes.evaluateAll((sections) => sections.map((s) => s.getBoundingClientRect()).map((r) => ({ haut: Math.round(r.top), bas: Math.round(r.bottom) })));
      expect(new Set(boites.map((b) => b.haut)).size).toBe(1);
      expect(Math.max(...boites.map((b) => b.bas))).toBeLessThanOrEqual(900);
      await context.close();
    }
  });

  test("chaque carte montre, centrées au-dessus du nom du niveau, les pastilles des classifications qu'il accepte, en français et en anglais", async ({ browser }) => {
    for (const [langue, pastilles] of [
      [
        "fr-FR",
        {
          "N1 Public": ["Classification NC · Public", "Classification C1 · Interne"],
          "N2 Interne": ["Classification C2 · Restreint"],
          "N3 Confidentiel": ["Classification C3 · Secret"],
          "Expérimental (bêta)": ["Classification NC · Public"],
        },
      ],
      [
        "en-US",
        {
          "N1 Public": ["Classification NC · Public", "Classification C1 · Internal"],
          "N2 Internal": ["Classification C2 · Restricted"],
          "N3 Confidential": ["Classification C3 · Secret"],
          "Experimental (beta)": ["Classification NC · Public"],
        },
      ],
    ] as const) {
      const context = await connecter(browser, salarie, langue);
      const page = await context.newPage();
      await page.goto("/catalogue");
      for (const [niveau, attendues] of Object.entries(pastilles)) {
        const images = carte(page, niveau).getByRole("img");
        await expect(images).toHaveCount(attendues.length);
        const titre = await carte(page, niveau).getByRole("heading", { level: 2 }).boundingBox();
        for (const [i, nom] of attendues.entries()) {
          await expect(images.nth(i)).toHaveAccessibleName(nom);
          expect(await images.nth(i).evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0), `${nom} chargée`).toBe(true);
          const pastille = await images.nth(i).boundingBox();
          expect(Math.abs(pastille!.x + pastille!.width / 2 - (titre!.x + titre!.width / 2)), `${nom} centrée`).toBeLessThanOrEqual(1);
          expect(pastille!.y + pastille!.height, `${nom} au-dessus du nom du niveau`).toBeLessThanOrEqual(titre!.y);
        }
      }
      await context.close();
    }
  });

  test("en français, aucune ligne ne commence par « ; : ! ? » : l'espace qui les précède est insécable", async ({ browser }) => {
    const context = await connecter(browser, salarie);
    const page = await context.newPage();
    await page.goto("/catalogue");
    const texte = await carte(page, "N3 Confidentiel").evaluate((section) => section.textContent ?? "");
    expect(texte).toContain("sous-traitance ; à terme");
    expect(texte).not.toMatch(/ [;:!?]/);
    await context.close();
  });

  test("chaque carte donne le nombre de modèles du niveau et son prix de départ", async ({ browser }) => {
    const context = await connecter(browser, salarie);
    const page = await context.newPage();
    await page.goto("/catalogue");
    // Données de démonstration : prix mixtes 0,175 € (public), 0,30 € (interne), 0,975 € (confidentiel), 2,50 € (modèle
    // d'images, prix de sortie par jeton d'image). Le modèle d'embeddings (N3, 0,01 € en entrée) compte parmi les modèles
    // des niveaux N1 à N3, mais pas dans leur prix de départ (ticket #126) ; l'API de décision du niveau Expérimental
    // non plus : ce niveau n'a pas de prix de départ.
    await expect(carte(page, "N1 Public")).toContainText(/5 modèles.*à partir de 0,175\s€/);
    await expect(carte(page, "N2 Interne")).toContainText(/3 modèles.*à partir de 0,30\s€/);
    await expect(carte(page, "N3 Confidentiel")).toContainText(/2 modèles.*à partir de 0,975\s€/);
    await expect(carte(page, "Expérimental (bêta)")).toContainText("1 modèle");
    await expect(carte(page, "Expérimental (bêta)")).not.toContainText("à partir de");
    await context.close();
  });

  test("« Demander une clé de ce niveau » préremplit le niveau, « Voir les modèles » ouvre la page du niveau", async ({ browser }) => {
    const context = await connecter(browser, salarie);
    const page = await context.newPage();
    await page.goto("/catalogue");
    await carte(page, "N2 Interne").getByRole("link", { name: "Demander une clé de ce niveau" }).click();
    await expect(page.getByRole("radio", { name: /^N2 Interne/ })).toBeChecked();
    await page.goto("/catalogue");
    await carte(page, "N3 Confidentiel").getByRole("link", { name: "Voir les modèles" }).click();
    await expect(page).toHaveURL(/\/catalogue\/n3$/);
    await context.close();
  });

  test("un niveau sans modèle visible affiche un message qui indique à qui s'adresser, sur sa carte et sur sa page (tickets #5 et #7)", async ({ browser }) => {
    const admin = await connecter(browser, ADMIN);
    const pageAdmin = await admin.newPage();
    await pageAdmin.goto("/gestion/catalogue");
    const fiche = pageAdmin.locator("section").filter({ has: pageAdmin.locator("code", { hasText: /^dev-experimental$/ }) });
    await fiche.getByLabel("Visible des collaborateurs").uncheck();
    await fiche.getByRole("button", { name: "Enregistrer" }).click();
    await expect(pageAdmin.getByRole("status")).toHaveText("Catalogue mis à jour.");
    const context = await connecter(browser, salarie);
    const page = await context.newPage();
    await page.goto("/catalogue");
    await expect(carte(page, "Expérimental (bêta)")).toContainText("Aucun modèle n'est encore ouvert à ce niveau");
    await page.goto("/catalogue/experimental");
    await expect(page.getByRole("main")).toContainText("Aucun modèle n'est encore ouvert à ce niveau. Pour en demander un, écrivez aux administrateurs du portail.");
    await enrichirModele(pageAdmin, { nom: "dev-experimental", nomAffiche: "Modèle expérimental", niveau: "EXP" });
    await Promise.all([admin.close(), context.close()]);
  });
});

test.describe("page d'un niveau (ticket #7)", () => {
  const modele = (page: Page, nom: string | RegExp) => page.getByRole("article", { name: nom });

  test("depuis la vue d'ensemble, la page N2 montre les modèles N2 et N3, ces derniers avec le badge « Accepte jusqu'à N3 »", async ({ browser }) => {
    const context = await connecter(browser, salarie);
    const page = await context.newPage();
    await page.goto("/catalogue");
    await page.getByRole("region", { name: "N2 Interne" }).getByRole("link", { name: "Voir les modèles" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("N2 Interne");
    await expect(modele(page, "Modèle interne")).toContainText("Mistral AI · UE");
    await expect(modele(page, "Modèle interne")).not.toContainText("Accepte jusqu'à");
    await expect(modele(page, "Modèle confidentiel")).toContainText("Accepte jusqu'à N3");
    await expect(modele(page, "Modèle vectoriel")).toContainText("Accepte jusqu'à N3");
    await expect(page.getByRole("article")).toHaveCount(3);
    await context.close();
  });

  test("la page Expérimental ne montre que le modèle expérimental", async ({ browser }) => {
    const context = await connecter(browser, salarie);
    const page = await context.newPage();
    await page.goto("/catalogue/experimental");
    await expect(modele(page, "Modèle expérimental")).toBeVisible();
    await expect(page.getByRole("article")).toHaveCount(1);
    await context.close();
  });

  test("une carte donne les capacités, le repère de prix, les prix exacts et le contexte en pages, en français et en anglais", async ({ browser }) => {
    const context = await connecter(browser, salarie);
    const page = await context.newPage();
    await page.goto("/catalogue/n3");
    // Modèle confidentiel de démonstration : 0,40 € en entrée, 2,70 € en sortie, soit un prix mixte de 0,975 € (€€).
    const carte = modele(page, "Modèle confidentiel");
    // La description courte tient en deux lignes au plus (spécification, récit 20).
    await expect(carte.getByText("Modèle de démonstration N3", { exact: true })).toHaveCSS("-webkit-line-clamp", "2");
    await expect(carte).toContainText("Lecture d'images");
    await expect(carte).toContainText("Raisonnement");
    await expect(carte).toContainText(/€€\s*·\s*0,40\s€ en entrée, 2,70\s€ en sortie/);
    await expect(carte).toContainText(/262\s000 jetons, soit environ 350 pages/);
    await expect(carte.getByTitle(/environ 750 jetons/)).toBeVisible();
    await context.close();

    const anglais = await connecter(browser, salarie, "en-US");
    const pageEn = await anglais.newPage();
    await pageEn.goto("/catalogue/n3");
    const carteEn = modele(pageEn, /Modèle confidentiel|Confidential model/);
    await expect(carteEn).toContainText(/€€\s*·\s*€0\.40 input, €2\.70 output/);
    await expect(carteEn).toContainText("262,000 tokens, or about 350 pages");
    await anglais.close();
  });

  test("en anglais, un modèle que l'admin n'a pas traduit s'affiche avec ses textes français", async ({ browser }) => {
    const context = await connecter(browser, salarie, "en-US");
    const page = await context.newPage();
    await page.goto("/catalogue/n2");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("N2 Internal");
    await expect(modele(page, "Modèle interne")).toContainText("Modèle de démonstration N2");
    await expect(modele(page, /Modèle confidentiel|Confidential model/)).toContainText("Accepts up to N3");
    await context.close();
  });

  test("sur un écran étroit, les cartes s'empilent", async ({ browser }) => {
    const context = await connecter(browser, salarie);
    const page = await context.newPage();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/catalogue/n1");
    const cadres = await Promise.all((await page.getByRole("article").all()).map((carte) => carte.boundingBox()));
    expect(cadres.length).toBeGreaterThan(1);
    for (const [precedent, suivant] of cadres.slice(1).map((cadre, i) => [cadres[i]!, cadre!])) {
      expect(suivant.x).toBe(precedent.x);
      expect(suivant.y).toBeGreaterThanOrEqual(precedent.y + precedent.height);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await context.close();
  });

  test("l'en-tête de chaque niveau montre ses pastilles de classification, comme la vue d'ensemble ; aucune page n'affiche d'emoji", async ({ browser }) => {
    const context = await connecter(browser, salarie);
    const page = await context.newPage();
    for (const [chemin, pastilles] of [
      ["/catalogue/n1", ["Classification NC · Public", "Classification C1 · Interne"]],
      ["/catalogue/n2", ["Classification C2 · Restreint"]],
      ["/catalogue/n3", ["Classification C3 · Secret"]],
      ["/catalogue/experimental", ["Classification NC · Public"]],
    ] as const) {
      await page.goto(chemin);
      const images = page.getByRole("main").locator("header").getByRole("img");
      await expect(images).toHaveCount(pastilles.length);
      for (const [i, nom] of pastilles.entries()) await expect(images.nth(i)).toHaveAccessibleName(nom);
      expect(await page.evaluate(() => document.body.innerText.match(/\p{Extended_Pictographic}/gu)), `emoji sur ${chemin}`).toBeNull();
    }
    await context.close();
  });
});

test.describe("filtres, tri et recommandations (ticket #8)", () => {
  const modele = (page: Page, nom: string) => page.getByRole("article", { name: nom });

  test("le salarié filtre par cas d'usage ; « Notre choix pour … » n'apparaît que sur la page du niveau maximal du modèle", async ({ browser }) => {
    const context = await connecter(browser, salarie);
    const page = await context.newPage();
    await page.goto("/catalogue/n1");
    await expect(modele(page, "Modèle public")).toContainText("Notre choix pour : Extraction et automatisation");
    await expect(modele(page, "Modèle interne")).not.toContainText("Notre choix");
    await page.getByRole("combobox", { name: "Cas d'usage" }).selectOption({ label: "Code" });
    await expect(page).toHaveURL(/cas=CODING/);
    await expect(page.getByRole("article")).toHaveCount(1);
    await expect(modele(page, "Modèle interne")).toBeVisible();

    await page.goto("/catalogue/n2");
    await expect(page.getByRole("article").first()).toHaveAccessibleName("Modèle interne");
    await expect(modele(page, "Modèle interne")).toContainText("Notre choix pour : Code");
    await context.close();
  });

  test("les filtres se combinent et se partagent par l'adresse ; sans résultat, un message invite à les élargir", async ({ browser }) => {
    const context = await connecter(browser, salarie);
    const page = await context.newPage();
    await page.goto("/catalogue/n1?ue=1&capacite=raisonnement");
    await expect(page.getByRole("checkbox", { name: "UE uniquement" })).toBeChecked();
    await expect(page.getByRole("article")).toHaveCount(1);
    await expect(modele(page, "Modèle confidentiel")).toBeVisible();
    await page.getByRole("searchbox", { name: "Rechercher un modèle ou un éditeur" }).fill("introuvable");
    await expect(page.getByRole("main")).toContainText("Aucun modèle ne correspond à ces critères. Élargissez la recherche ou retirez des filtres.");
    await page.getByRole("link", { name: "Réinitialiser les filtres" }).click();
    await expect(page.getByRole("article")).toHaveCount(5);
    await context.close();
  });
});

test.describe("filtres appliqués sans bouton (retours de recette du 2026-09-25)", () => {
  test("chaque critère s'applique dès qu'il change ; la recherche attend trois caractères", async ({ browser }) => {
    const context = await connecter(browser, salarie);
    const page = await context.newPage();
    await page.goto("/catalogue/n1");
    await expect(page.getByRole("button", { name: "Filtrer" })).toHaveCount(0);
    const recherche = page.getByRole("searchbox", { name: "Rechercher un modèle ou un éditeur" });
    await recherche.fill("in");
    await page.waitForTimeout(800);
    await expect(page).not.toHaveURL(/q=/);
    await expect(page.getByRole("article")).toHaveCount(5);
    await recherche.fill("int");
    await expect(page).toHaveURL(/q=int/);
    await expect(page.getByRole("article")).toHaveCount(1);
    await expect(page.getByRole("article", { name: "Modèle interne" })).toBeVisible();
    await expect(recherche).toBeFocused();
    await recherche.fill("");
    await expect(page).not.toHaveURL(/q=/);
    await expect(page.getByRole("article")).toHaveCount(5);
    await page.getByRole("checkbox", { name: "UE uniquement" }).check();
    await expect(page).toHaveURL(/ue=1/);
    await expect(page.getByRole("article")).toHaveCount(3);
    await context.close();
  });

  test("un critère choisi avant que la page soit prête s'applique dès qu'elle l'est", async ({ browser }) => {
    const context = await connecter(browser, salarie);
    const page = await context.newPage();
    // Le JavaScript de la page est retenu : le formulaire s'affiche, mais le filtrage automatique n'est pas encore actif.
    let liberer = () => {};
    const retenu = new Promise<void>((resolve) => (liberer = resolve));
    await page.route(
      (url) => url.pathname.startsWith("/_next/static/") && url.pathname.endsWith(".js"),
      async (route) => {
        await retenu;
        await route.continue();
      },
    );
    await page.goto("/catalogue/n1", { waitUntil: "commit" });
    await page.getByRole("combobox", { name: "Cas d'usage" }).selectOption({ label: "Code" });
    liberer();
    await expect(page).toHaveURL(/cas=CODING/);
    await expect(page.getByRole("article")).toHaveCount(1);
    await expect(page.getByRole("article", { name: "Modèle interne" })).toBeVisible();
    await context.close();
  });

  test("le filtre propose les quatre cas d'usage, dont la création d'images", async ({ browser }) => {
    const context = await connecter(browser, salarie);
    const page = await context.newPage();
    await page.goto("/catalogue/n1");
    await expect(page.getByRole("combobox", { name: "Cas d'usage" }).locator("option")).toHaveText([
      "Tous les cas d'usage",
      "Rédaction et analyse",
      "Code",
      "Extraction et automatisation",
      "Création d'images",
    ]);
    await context.close();
  });

  test("les capacités, dont la lecture et la génération d'images, se choisissent dans une colonne", async ({ browser }) => {
    const context = await connecter(browser, salarie);
    const page = await context.newPage();
    await page.goto("/catalogue/n1");
    const capacites = page.getByRole("group", { name: "Capacités" }).getByRole("checkbox");
    await expect(page.getByRole("group", { name: "Capacités" }).locator("label")).toHaveText([
      /Lecture d'images$/,
      /Génération d'images$/,
      /Audio et vidéo$/,
      /Raisonnement$/,
    ]);
    const positions = await capacites.evaluateAll((cases) => cases.map((c) => c.getBoundingClientRect()).map((r) => ({ x: Math.round(r.left), y: Math.round(r.top) })));
    expect(new Set(positions.map((p) => p.x)).size).toBe(1);
    expect(positions.map((p) => p.y)).toEqual([...positions.map((p) => p.y)].sort((a, b) => a - b));
    expect(new Set(positions.map((p) => p.y)).size).toBe(4);
    await context.close();
  });

  test("les libellés de la recherche, du cas d'usage, des capacités et de « UE uniquement » sont alignés", async ({ browser }) => {
    const context = await connecter(browser, salarie);
    const page = await context.newPage();
    await page.goto("/catalogue/n1");
    const hauts = await page.evaluate(() =>
      [
        document.querySelector('input[name="q"]')?.closest("label"),
        document.querySelector('select[name="cas"]')?.closest("label"),
        document.querySelector("fieldset legend"),
        document.querySelector('input[name="ue"]')?.closest("label"),
      ].map((libelle) => (libelle ? Math.round(libelle.getBoundingClientRect().top) : null)),
    );
    expect(hauts.every((haut) => haut !== null && haut === hauts[0]), `hauts des libellés : ${hauts.join(", ")}`).toBe(true);
    await context.close();
  });
});

test.describe("filtre par type d'API (ticket #128)", () => {
  test("le filtre ne propose que les types présents sur la page ; il garde les seuls modèles du type choisi, et manque à une page d'un seul type", async ({ browser }) => {
    const context = await connecter(browser, salarie);
    const page = await context.newPage();
    await page.goto("/catalogue/n1");
    const filtre = page.getByRole("combobox", { name: "Type d'API" });
    await expect(filtre.getByRole("option")).toHaveText(["Tous les types", "Conversation", "Images", "Embeddings"]);
    await filtre.selectOption({ label: "Embeddings" });
    await expect(page).toHaveURL(/type=embeddings/);
    await expect(page.getByRole("article")).toHaveCount(1);
    await expect(page.getByRole("article", { name: "Modèle vectoriel" })).toBeVisible();
    await page.goto("/catalogue/experimental");
    await expect(page.getByRole("article")).toHaveCount(1);
    await expect(page.getByRole("combobox", { name: "Type d'API" })).toHaveCount(0);
    await context.close();
  });
});

test.describe("détail d'un modèle (ticket #9)", () => {
  const panneau = (page: Page) => page.getByRole("dialog");

  test("chaque carte mène à la fiche détaillée par un lien explicite ; sur un écran bas, la fiche défile et montre tout l'exemple d'appel", async ({ browser }) => {
    const context = await connecter(browser, salarie);
    const page = await context.newPage();
    await page.setViewportSize({ width: 1280, height: 600 });
    await page.goto("/catalogue/n1");
    await page.getByRole("article", { name: "Modèle graphique" }).getByRole("link", { name: "Voir la fiche détaillée de Modèle graphique" }).click();
    await expect(panneau(page).getByRole("heading", { level: 2 })).toHaveText("Modèle graphique");
    // L'exemple d'appel s'affiche en entier, sans ascenseur à lui : c'est la fiche qui défile.
    const exemple = panneau(page).locator("pre");
    expect(await exemple.evaluate((e) => ({ hauteur: e.scrollHeight - e.clientHeight, largeur: e.scrollWidth - e.clientWidth }))).toEqual({ hauteur: 0, largeur: 0 });
    expect(await panneau(page).evaluate((e) => e.scrollHeight > e.clientHeight)).toBe(true);
    await panneau(page).getByRole("button", { name: "Copier l'exemple" }).scrollIntoViewIfNeeded();
    await expect(panneau(page).getByRole("button", { name: "Copier l'exemple" })).toBeInViewport();
    await context.close();
  });

  test("un clic sur un modèle ouvre son détail ; le fermer rend la page avec ses filtres et son tri", async ({ browser }) => {
    const context = await connecter(browser, salarie);
    const page = await context.newPage();
    await page.goto("/catalogue/n1?ue=1&tri=nom");
    await page.getByRole("article", { name: "Modèle confidentiel" }).getByRole("link", { name: "Modèle confidentiel", exact: true }).click();
    await expect(page).toHaveURL(/\/catalogue\/n1\?ue=1&tri=nom&modele=dev-confidentiel$/);
    await expect(panneau(page)).toContainText("Modèle de démonstration N3, à réponses simulées.");
    await expect(panneau(page).getByRole("heading", { name: "Hébergeurs" })).toBeVisible();
    await expect(panneau(page)).toContainText("OVHcloud");
    await expect(panneau(page).getByRole("heading", { name: "Limites connues" })).toBeVisible();
    await expect(panneau(page).locator("pre")).toContainText("http://127.0.0.1:54400/admin/v1/chat/completions");
    await expect(panneau(page).locator("pre")).toContainText('"model": "dev-confidentiel"');
    await panneau(page).getByRole("link", { name: "Fermer" }).click();
    await expect(panneau(page)).toHaveCount(0);
    await expect(page).toHaveURL(/\/catalogue\/n1\?ue=1&tri=nom$/);
    await expect(page.getByRole("checkbox", { name: "UE uniquement" })).toBeChecked();
    await expect(page.getByRole("combobox", { name: "Trier par" })).toHaveValue("nom");
    await context.close();
  });

  test("un modèle d'images annonce un prix par image, sans contexte en jetons, et son exemple d'appel demande une image", async ({ browser }) => {
    const context = await connecter(browser, salarie);
    const page = await context.newPage();
    await page.goto("/catalogue/n1");
    const carte = page.getByRole("article", { name: "Modèle graphique" });
    await expect(carte).toContainText("Génération d'images");
    await expect(carte).toContainText("Notre choix pour : Création d'images");
    await expect(carte).toContainText(/Environ 0,03\s€ par image/);
    await expect(carte).not.toContainText("jetons");
    await carte.getByRole("link", { name: "Modèle graphique", exact: true }).click();
    await expect(panneau(page).getByRole("heading", { name: "Modèle d'images" })).toBeVisible();
    await expect(panneau(page).locator("pre")).toContainText('"modalities": [');
    await expect(panneau(page).locator("pre")).toContainText("base64");
    await context.close();
  });

  test("un modèle d'embeddings annonce son prix d'entrée seul, la taille de ses vecteurs et son contexte (ticket #126)", async ({ browser }) => {
    const context = await connecter(browser, salarie);
    const page = await context.newPage();
    await page.goto("/catalogue/n3");
    const carte = page.getByRole("article", { name: "Modèle vectoriel" });
    await expect(carte).toContainText(/0,01\s€ en entrée, par\smillion\sde\sjetons/);
    await expect(carte).not.toContainText("en sortie");
    await expect(carte).toContainText(/Vecteurs de 1\s024 dimensions/);
    await expect(carte).toContainText(/8\s000 jetons/);
    await context.close();
  });

  test("la fiche d'un modèle d'embeddings explique qu'il ne converse pas, et son exemple appelle /v1/embeddings, en français et en anglais (ticket #127)", async ({ browser }) => {
    for (const [langue, titre, explication] of [
      ["fr-FR", "Modèle d'embeddings", "ne converse pas"],
      ["en-US", "Embedding model", "does not chat"],
    ] as const) {
      const context = await connecter(browser, salarie, langue);
      const page = await context.newPage();
      await page.goto("/catalogue/n3?modele=dev-embeddings");
      await expect(panneau(page).getByRole("heading", { name: titre })).toBeVisible();
      await expect(panneau(page)).toContainText(explication);
      const exemple = panneau(page).locator("pre");
      await expect(exemple).toContainText("/v1/embeddings");
      await expect(exemple).toContainText('"model": "dev-embeddings"');
      await expect(exemple).toContainText('"input": [');
      await expect(exemple).not.toContainText("chat/completions");
      await context.close();
    }
  });

  test("un lien partagé ouvre la page du niveau avec le détail de JEV, présenté comme une API de décision", async ({ browser }) => {
    const context = await connecter(browser, salarie);
    const page = await context.newPage();
    await page.goto("/catalogue/experimental?modele=dev-experimental");
    await expect(panneau(page).getByRole("heading", { level: 2 })).toHaveText("Modèle expérimental");
    await expect(panneau(page)).toContainText("API de décision");
    await expect(panneau(page).locator("pre")).toContainText('"model": "dev-experimental"');
    await expect(panneau(page).locator("pre")).toContainText('\\"questions\\"');
    await context.close();
  });

  test("le détail est traduit, avec repli sur les textes français", async ({ browser }) => {
    const context = await connecter(browser, salarie, "en-US");
    const page = await context.newPage();
    await page.goto("/catalogue/n2?modele=dev-interne");
    await expect(panneau(page).getByRole("heading", { name: "Known limitations" })).toBeVisible();
    await expect(panneau(page)).toContainText("Modèle de démonstration N2, à réponses simulées.");
    await expect(panneau(page).getByRole("link", { name: "Close" })).toBeVisible();
    await context.close();
  });
});

/** Modèles proposés par le formulaire de demande (valeurs des cases à cocher). */
function modelesProposes(page: Page): Promise<string[]> {
  return page.locator('input[name="models"]').evaluateAll((cases) => cases.map((c) => (c as HTMLInputElement).value));
}

/** Ajoute au formulaire de demande un champ que l'interface ne propose pas, comme le ferait une requête forgée. */
async function ajouterAuFormulaire(page: Page, nom: string, valeur: string): Promise<void> {
  await page.locator("main form").evaluate(
    (form, [n, v]) => {
      const champ = document.createElement("input");
      Object.assign(champ, { type: "hidden", name: n, value: v });
      form.append(champ);
    },
    [nom, valeur],
  );
}

test.describe("sélection de modèles et demande préremplie (ticket #10)", () => {
  const bouton = (page: Page) => page.getByRole("button", { name: "Demander une clé pour la sélection" });

  test("sur la page N2, le salarié sélectionne deux modèles, dont un N3, et soumet une demande déclarée au niveau N2", async ({ browser }) => {
    const context = await connecter(browser, salarie);
    const page = await context.newPage();
    await page.goto("/catalogue/n2");
    await expect(bouton(page)).toBeDisabled();
    await page.getByRole("checkbox", { name: "Sélectionner Modèle interne" }).check();
    await expect(bouton(page)).toBeEnabled();
    await page.getByRole("checkbox", { name: "Sélectionner Modèle confidentiel" }).check();
    await bouton(page).click();

    await expect(page).toHaveURL(/\/demandes\/nouvelle\?/);
    await expect(page.getByRole("radio", { name: /^N2 Interne/ })).toBeChecked();
    await expect(page.getByLabel(/Modèle interne/)).toBeChecked();
    await expect(page.getByLabel(/Modèle confidentiel/)).toBeChecked();
    await expect(page.getByLabel(/Modèle public/)).toHaveCount(0);
    await page.getByLabel("Équipe").selectOption({ label: "R&D" });
    await page.getByLabel("Motif").fill("Synthèse de documents internes");
    await page.getByLabel(/Je m'engage/).check();
    await page.getByRole("button", { name: "Envoyer la demande" }).click();
    await expect(page.getByRole("status")).toHaveText("Demande envoyée aux administrateurs.");
    // Modèles dans l'ordre du formulaire, par nom affiché.
    await expect(page.getByRole("row", { name: /Clé d'API.*R&D.*N2 Interne.*dev-confidentiel, dev-interne.*Soumise/ })).toBeVisible();
    await context.close();
  });

  test("décocher tous les modèles désactive le bouton ; ouvrir puis fermer un détail garde la sélection", async ({ browser }) => {
    const context = await connecter(browser, salarie);
    const page = await context.newPage();
    await page.goto("/catalogue/n1?tri=nom");
    const selection = page.getByRole("checkbox", { name: "Sélectionner Modèle public" });
    await selection.check();
    await page.getByRole("article", { name: "Modèle interne" }).getByRole("link", { name: "Modèle interne", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("dialog").getByRole("link", { name: "Fermer" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(selection).toBeChecked();
    await expect(bouton(page)).toBeEnabled();
    await selection.uncheck();
    await expect(bouton(page)).toBeDisabled();
    await context.close();
  });

  test("le formulaire de demande ne propose que les modèles qui acceptent le niveau choisi", async ({ browser }) => {
    const context = await connecter(browser, salarie);
    const page = await context.newPage();
    await page.goto("/demandes/nouvelle");
    const proposes = async () => (await modelesProposes(page)).sort();
    await expect(page.getByText("Choisissez d'abord le niveau de confidentialité")).toBeVisible();
    expect(await proposes()).toEqual([]);
    for (const [niveau, attendus] of [
      [/^N3 Confidentiel/, ["dev-confidentiel", "dev-embeddings"]],
      [/^N2 Interne/, ["dev-confidentiel", "dev-embeddings", "dev-interne"]],
      [/^N1 Public/, ["dev-confidentiel", "dev-embeddings", "dev-image", "dev-interne", "dev-public"]],
      [/^Expérimental/, ["dev-experimental"]],
    ] as const) {
      await page.getByRole("radio", { name: niveau }).check();
      await expect.poll(proposes).toEqual(attendus);
    }
    await context.close();
  });

  test("une adresse préremplie modifiée à la main ne contourne pas les contrôles de la demande", async ({ browser }) => {
    const context = await connecter(browser, salarie);
    const page = await context.newPage();
    await page.goto("/demandes/nouvelle?niveau=N3&modeles=dev-public");
    await expect(page.getByRole("radio", { name: /^N3 Confidentiel/ })).toBeChecked();
    await expect(page.getByLabel(/Modèle public/)).toHaveCount(0);
    // Envoyé quand même, par une requête forgée, le modèle N1 est refusé par le serveur.
    await ajouterAuFormulaire(page, "models", "dev-public");
    await page.getByLabel("Équipe").selectOption({ label: "R&D" });
    await page.getByLabel("Motif").fill("Contrats clients");
    await page.getByLabel(/Je m'engage/).check();
    await page.getByRole("button", { name: "Envoyer la demande" }).click();
    await expect(page.getByRole("main").getByRole("alert")).toContainText("Les modèles acceptent le niveau de confidentialité déclaré (dev-public)");
    await context.close();
  });
});
