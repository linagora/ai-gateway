import { expect, test } from "@playwright/test";
import { ADMIN, connecter, demandeApprouvee, enrichirModele } from "./outils";

/* Tableau de bord des admins : pastilles de ce qui attend, archives de ce qui est traité (retours de recette du 2026-09-25). */
const suffixe = Date.now().toString(36);
const personne = (n: string) => ({ uid: `gestion-${n}-${suffixe}`, email: `gestion-${n}-${suffixe}@example.org`, name: `Personne ${n} ${suffixe}` });

test.beforeAll(async ({ browser }) => {
  const context = await connecter(browser, ADMIN);
  await enrichirModele(await context.newPage(), { nom: "dev-public", nomAffiche: "Modèle public", niveau: "N1" });
  await context.close();
});

test("le menu signale les demandes à valider et les clés à retirer ; les pages gardent l'archive de ce qui est traité", async ({ browser }) => {
  const salarie = personne("pastilles");
  const page = await (await connecter(browser, salarie)).newPage();
  await demandeApprouvee(browser, page, salarie, "Essai pastilles");
  const autre = personne("attente");
  const pageAutre = await (await connecter(browser, autre)).newPage();
  await pageAutre.goto("/demandes/adhesion");
  await pageAutre.getByLabel("Motif").fill("Rejoindre une équipe");
  await pageAutre.getByRole("button", { name: "Envoyer la demande" }).click();
  await expect(pageAutre.getByRole("status")).toHaveText("Demande d'accès envoyée.");

  const admin = await (await connecter(browser, ADMIN)).newPage();
  await admin.goto("/gestion/demandes");
  const menu = admin.getByRole("navigation", { name: "Administration" });
  await expect(menu.getByRole("link", { name: /^Demandes \(\d+ demandes? à valider\)$/ })).toBeVisible();
  await expect(menu.getByRole("link", { name: /^Clés \(\d+ clés? à retirer\)$/ })).toBeVisible();
  await expect(admin.getByRole("banner").getByRole("link", { name: /^Gestion \(\d+ demandes? à valider\)$/ })).toBeVisible();
  const archive = admin.getByRole("region", { name: "Archive : demandes traitées" });
  await expect(archive.getByRole("row", { name: new RegExp(`${salarie.uid}.*Clé d'API.*Approuvée`) })).toBeVisible();
  // L'archive se lit page par page, la plus récente d'abord ; une page hors limites mène à la dernière.
  const pagination = archive.getByRole("navigation", { name: "Pages de l'archive" });
  await expect(pagination).toContainText(/^Page 1 sur \d+ \(\d+ demandes? traitées?\)/);
  const pages = Number(/sur (\d+)/.exec((await pagination.textContent()) ?? "")?.[1]);
  await admin.goto("/gestion/demandes?page=999");
  await expect(pagination).toContainText(`Page ${pages} sur ${pages}`);
  await admin.goto("/gestion/demandes");

  await menu.getByRole("link", { name: /^Clés/ }).click();
  await expect(admin.getByRole("region", { name: "Clés approuvées, à retirer par le salarié" }).getByRole("row", { name: new RegExp(salarie.uid) })).toBeVisible();
  await expect(admin.getByRole("region", { name: "Archive : clés révoquées ou expirées" })).toBeVisible();
});

test("l'onglet « Outils » mène, dans un nouvel onglet, aux fonctions réservées aux admins hors du portail : reporting et passerelle", async ({ browser }) => {
  const admin = await (await connecter(browser, ADMIN)).newPage();
  await admin.goto("/gestion/demandes");
  await admin.getByRole("navigation", { name: "Administration" }).getByRole("link", { name: "Outils" }).click();
  await expect(admin.getByRole("heading", { level: 1 })).toHaveText("Outils d'administration");
  for (const [nom, adresse] of [
    ["Tableau de bord « Consommation »", "/stats/superset/dashboard/consommation/"],
    ["Tableau de bord « Pilotage »", "/stats/superset/dashboard/pilotage/"],
    ["Tableau de bord « Par salarié »", "/stats/superset/dashboard/par-salarie/"],
    ["Accueil de Superset", "/stats/"],
    ["Console LiteLLM", "/admin/ui/"],
    ["Schéma OpenAPI de l'API d'administration", "/admin/openapi.json"],
  ]) {
    const lien = admin.getByRole("link", { name: new RegExp(`^${nom} \\(nouvel onglet\\)$`) });
    await expect(lien).toHaveAttribute("href", adresse);
    await expect(lien).toHaveAttribute("target", "_blank");
  }

  // Un salarié n'y a pas accès.
  const salarie = await (await connecter(browser, personne("outils"))).newPage();
  expect((await salarie.goto("/gestion/outils"))?.status()).toBe(404);
});
