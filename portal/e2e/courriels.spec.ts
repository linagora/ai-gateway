import { expect, test } from "@playwright/test";
import { ajouterAEquipe, connecter, courriels, enrichirModele, ADMIN } from "./outils";

/* Courriels du portail (spécification #14), lus dans Mailpit. Admins à notifier : admins-e2e@example.org (.env). */
const suffixe = Date.now().toString(36);
const personne = (n: string) => ({ uid: `courriel-${n}-${suffixe}`, email: `courriel-${n}-${suffixe}@example.org`, name: `Personne ${n} ${suffixe}` });

test.beforeAll(async ({ browser }) => {
  const context = await connecter(browser, ADMIN);
  await enrichirModele(await context.newPage(), { nom: "dev-public", nomAffiche: "Modèle public", niveau: "N1" });
  await context.close();
});

test("une nouvelle demande de clé est notifiée aux admins par un courriel bilingue, avec un lien vers sa fiche (ticket #23)", async ({ browser }) => {
  const salarie = personne("notification");
  const page = await (await connecter(browser, salarie)).newPage();
  await ajouterAEquipe(salarie.uid, "R&D");
  await page.goto("/demandes/nouvelle");
  await page.getByLabel("Équipe").selectOption({ label: "R&D" });
  await page.getByRole("radio", { name: /^N1 — Public/ }).check();
  await page.getByLabel(/Modèle public/).check();
  await page.getByLabel("Motif").fill("Essai des courriels");
  await page.getByLabel(/Je m'engage/).check();
  await page.getByRole("button", { name: "Envoyer la demande" }).click();
  await expect(page.getByRole("status")).toHaveText("Demande envoyée aux administrateurs.");

  await expect.poll(async () => (await courriels(salarie.uid)).length, { timeout: 15_000 }).toBe(1);
  const [courriel] = await courriels(salarie.uid);
  expect(courriel.to).toEqual(["admins-e2e@example.org"]);
  expect(courriel.subject).toBe("Nouvelle demande de clé d'API / New API key request");
  expect(courriel.text).toContain(`${salarie.uid} a demandé une clé d'API pour l'équipe R&D (N1 — Public).`);
  expect(courriel.text).toContain(`${salarie.uid} requested an API key for the R&D team (N1 — Public).`);
  expect(courriel.text).toMatch(/Lien : http:\/\/localhost:3100\/gestion\/demandes\/\w+/);
});
