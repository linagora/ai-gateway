import { expect, type Locator, test } from "@playwright/test";
import { ADMIN, connecter } from "./outils";

/*
 * Onglets actifs (retours de l'utilisateur du 2026-09-26) : dans le menu principal comme dans celui de la gestion,
 * l'onglet dont relève la page est marqué pour les lecteurs d'écran (aria-current) et souligné du rouge LINAGORA.
 */
const ROUGE_LINAGORA = "rgb(197, 28, 66)";

/** Dans la zone, un seul lien est l'onglet courant : celui nommé, souligné de rouge. */
async function ongletCourant(zone: Locator, nom: RegExp) {
  const courant = zone.locator("a[aria-current]");
  await expect(courant).toHaveCount(1);
  await expect(courant).toHaveAccessibleName(nom);
  await expect(courant).toHaveCSS("border-bottom-color", ROUGE_LINAGORA);
}

test("le menu principal souligne l'onglet de la page, sous-pages et formulaires de demande compris", async ({ browser }) => {
  const page = await (await connecter(browser, ADMIN)).newPage();
  const entete = page.getByRole("banner");
  await page.goto("/");
  await expect(entete.locator("a[aria-current]")).toHaveCount(0);
  for (const [chemin, onglet] of [
    ["/catalogue", /^Catalogue$/],
    ["/catalogue/abonnements", /^Catalogue$/],
    ["/demandes", /^Mes demandes/],
    ["/demandes/nouvelle", /^Nouvelle demande$/],
    ["/demandes/adhesion", /^Nouvelle demande$/],
    ["/cles", /^Mes clés/],
    ["/abonnements", /^Mes abonnements/],
    ["/documentation/api", /^API$/],
    ["/documentation/api/guide", /^API$/],
  ] as const) {
    await page.goto(chemin);
    await ongletCourant(entete, onglet);
  }
  // D'une page à l'autre sans rechargement : la demande d'une offre du catalogue relève de « Nouvelle demande ».
  await page.goto("/catalogue/abonnements");
  await page.getByRole("button", { name: "Demander cet abonnement" }).first().click();
  await expect(page).toHaveURL(/\/demandes\/abonnement\?offre=/);
  await ongletCourant(entete, /^Nouvelle demande$/);
  await expect(entete.getByRole("link", { name: /^Catalogue$/ })).not.toHaveCSS("border-bottom-color", ROUGE_LINAGORA);
});

test("la gestion souligne « Gestion » dans l'en-tête et, dans son menu, l'onglet de la page", async ({ browser }) => {
  const admin = await (await connecter(browser, ADMIN)).newPage();
  const entete = admin.getByRole("banner");
  const menu = admin.getByRole("navigation", { name: "Administration" });
  for (const [chemin, onglet] of [
    ["/gestion/demandes", /^Demandes/],
    ["/gestion/cles", /^Clés$/],
    ["/gestion/abonnements", /^Abonnements$/],
    ["/gestion/equipes", /^Équipes$/],
    ["/gestion/collaborateurs", /^Collaborateurs$/],
    ["/gestion/remboursements", /^Remboursements$/],
    ["/gestion/catalogue", /^Catalogue$/],
    ["/gestion/parametres", /^Valeurs par défaut$/],
    ["/gestion/integrations", /^Intégrations$/],
    ["/gestion/outils", /^Outils$/],
  ] as const) {
    await admin.goto(chemin);
    await ongletCourant(entete, /^Gestion/);
    await ongletCourant(menu, onglet);
  }
  // La page d'une équipe relève de l'onglet « Équipes ».
  await admin.goto("/gestion/equipes");
  await admin.locator('main a[href^="/gestion/equipes/"]').first().click();
  await expect(admin).toHaveURL(/\/gestion\/equipes\/.+/);
  await ongletCourant(entete, /^Gestion/);
  await ongletCourant(menu, /^Équipes$/);
});

test("l'onglet suit l'adresse même quand elle change avant la fin de l'hydratation, sans erreur d'hydratation", async ({ browser }) => {
  const admin = await (await connecter(browser, ADMIN)).newPage();
  const erreurs: string[] = [];
  admin.on("console", (message) => {
    if (message.type() === "error" && message.text().includes("hydrated")) erreurs.push(message.text());
  });
  // Le JavaScript de la page est retenu, le temps que l'adresse change : ainsi quand un clic lance une navigation avant
  // la fin de l'hydratation, le HTML du serveur (la file) ne correspond plus à l'adresse (une fiche).
  let liberer = () => {};
  const retenu = new Promise<void>((resolve) => (liberer = resolve));
  await admin.route(
    (url) => url.pathname.startsWith("/_next/static/") && url.pathname.endsWith(".js"),
    async (route) => {
      await retenu;
      await route.continue();
    },
  );
  await admin.goto("/gestion/demandes", { waitUntil: "commit" });
  await expect(admin.getByRole("heading", { level: 1 })).toHaveText("Demandes en attente de validation");
  await admin.evaluate(() => history.replaceState(null, "", "/gestion/demandes/une-fiche"));
  liberer();
  // Sur une fiche, « Gestion » et « Demandes » sont les onglets de la section, et non de la page elle-même.
  await expect(admin.getByRole("banner").getByRole("link", { name: /^Gestion/ })).toHaveAttribute("aria-current", "true");
  await expect(admin.getByRole("navigation", { name: "Administration" }).getByRole("link", { name: /^Demandes/ })).toHaveAttribute("aria-current", "true");
  expect(erreurs).toEqual([]);
});
