import { expect, test } from "@playwright/test";
import { ADMIN, ajouterAEquipe, connecter, enrichirModele } from "./outils";

/* À la validation, l'admin peut changer l'équipe d'une demande d'adhésion ou d'une demande de clé (décision du 2026-09-25). */
const suffixe = Date.now().toString(36);
const personne = (n: string) => ({ uid: `validation-${n}-${suffixe}`, email: `validation-${n}-${suffixe}@example.org`, name: `Personne ${n} ${suffixe}` });

test.beforeAll(async ({ browser }) => {
  const context = await connecter(browser, ADMIN);
  await enrichirModele(await context.newPage(), { nom: "dev-public", nomAffiche: "Modèle public", niveau: "N1" });
  await context.close();
});

test("l'admin affecte à une autre équipe le salarié qui demandait à rejoindre R&D", async ({ browser }) => {
  const salarie = personne("adhesion");
  const page = await (await connecter(browser, salarie)).newPage();
  await page.goto("/demandes/adhesion");
  await page.getByLabel("Équipe").selectOption({ label: "R&D" });
  await page.getByLabel("Motif").fill("Rejoindre mon équipe");
  await page.getByRole("button", { name: "Envoyer la demande" }).click();
  await expect(page.getByRole("status")).toHaveText("Demande d'adhésion envoyée.");

  const admin = await (await connecter(browser, ADMIN)).newPage();
  await admin.goto("/gestion/demandes");
  await admin.getByRole("row", { name: new RegExp(`${salarie.uid}.*Adhésion`) }).getByRole("link", { name: "Examiner" }).click();
  await admin.getByLabel("Équipe d'affectation").selectOption({ label: "LPS Paris" });
  await admin.getByRole("button", { name: /Approuver : ajouter/ }).click();
  await expect(admin.getByRole("status")).toHaveText("Adhésion approuvée : le demandeur a été ajouté à l'équipe.");

  await page.goto("/demandes");
  await expect(page.getByRole("row", { name: /Adhésion à une équipe.*LPS Paris.*Approuvée/ })).toBeVisible();
  await page.goto("/demandes/nouvelle");
  await expect(page.getByLabel("Équipe").locator("option")).toHaveText(["LPS Paris"]);
});

test("l'admin rattache à une autre équipe la clé demandée pour R&D, et y ajoute le demandeur", async ({ browser }) => {
  const salarie = personne("cle");
  const context = await connecter(browser, salarie);
  await ajouterAEquipe(salarie.uid, "R&D");
  const page = await context.newPage();
  await page.goto("/demandes/nouvelle");
  await page.getByLabel("Équipe").selectOption({ label: "R&D" });
  await page.getByRole("radio", { name: /^N1 — Public/ }).check();
  await page.getByLabel(/Modèle public/).check();
  await page.getByLabel("Motif").fill("Veille technologique");
  await page.getByLabel(/Je m'engage/).check();
  await page.getByRole("button", { name: "Envoyer la demande" }).click();
  await expect(page.getByRole("status")).toHaveText("Demande envoyée aux administrateurs.");

  const admin = await (await connecter(browser, ADMIN)).newPage();
  await admin.goto("/gestion/demandes");
  await admin.getByRole("row", { name: new RegExp(`${salarie.uid}.*Clé d'API`) }).getByRole("link", { name: "Examiner" }).click();
  await admin.getByLabel("Équipe de la clé").selectOption({ label: "LPS Paris" });
  await admin.getByRole("button", { name: "Approuver", exact: true }).click();
  await expect(admin.getByRole("status")).toHaveText("Demande approuvée.");

  await page.goto("/demandes");
  await expect(page.getByRole("row", { name: /Clé d'API.*LPS Paris.*N1 — Public.*dev-public.*Approuvée/ })).toBeVisible();
  await page.goto("/demandes/nouvelle");
  await expect(page.getByLabel("Équipe")).toContainText("LPS Paris");
});
