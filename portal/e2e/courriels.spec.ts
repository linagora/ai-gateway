import { expect, type Page, test } from "@playwright/test";
import { ADMIN, ajouterAEquipe, connecter, courriels, demandeApprouvee, enrichirModele } from "./outils";

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

test("le demandeur reçoit l'approbation de sa demande, avec l'échéance de retrait et un lien vers « Mes clés » (ticket #24)", async ({ browser }) => {
  const salarie = personne("approbation");
  const page = await (await connecter(browser, salarie)).newPage();
  await demandeApprouvee(browser, page, salarie, "Essai approbation");

  await expect.poll(async () => (await courriels(`to:${salarie.email}`)).length, { timeout: 15_000 }).toBe(1);
  const [courriel] = await courriels(`to:${salarie.email}`);
  expect(courriel.subject).toBe("Votre demande de clé est approuvée / Your key request is approved");
  expect(courriel.text).toMatch(/Votre demande de clé d'API pour l'équipe R&D est approuvée\. Retirez votre clé avant le \d{1,2} \S+ \d{4} dans « Mes clés »\./);
  expect(courriel.text).toContain("Lien : http://localhost:3100/cles");
  expect(courriel.text).not.toMatch(/sk-/);
});

/** Délai de retrait (jours) réglé par l'admin dans les valeurs par défaut. */
async function delaiDeRetrait(admin: Page, jours: string): Promise<void> {
  await admin.goto("/gestion/parametres");
  await admin.getByLabel("Délai de retrait d'une clé approuvée (jours)").fill(jours);
  await admin.getByRole("button", { name: "Enregistrer" }).click();
  await expect(admin.getByRole("status")).toHaveText("Paramètres enregistrés.");
}

test("la route de la tâche quotidienne refuse un appel sans le bon jeton (ticket #25)", async ({ request }) => {
  expect((await request.post("/api/taches/quotidienne")).status()).toBe(401);
  expect((await request.post("/api/taches/quotidienne", { headers: { Authorization: "Bearer mauvais-jeton" } })).status()).toBe(401);
});

test("la tâche quotidienne rappelle au titulaire le retrait de sa clé avant l'échéance (ticket #25)", async ({ browser, request }) => {
  const admin = await (await connecter(browser, ADMIN)).newPage();
  // Délai de retrait d'un jour : l'échéance tombe dans les trois jours, le rappel part au passage de la tâche.
  await delaiDeRetrait(admin, "1");
  try {
    const salarie = personne("rappel");
    const page = await (await connecter(browser, salarie)).newPage();
    await demandeApprouvee(browser, page, salarie, "Essai rappel");
    const reponse = await request.post("/api/taches/quotidienne", { headers: { Authorization: "Bearer dev-task-token" } });
    expect(reponse.status()).toBe(200);
    expect(await reponse.json()).toMatchObject({ rappelsRetrait: expect.any(Number), clesExpirees: expect.any(Number) });

    await expect.poll(async () => (await courriels(`to:${salarie.email} subject:Rappel`)).length, { timeout: 15_000 }).toBe(1);
    const [rappel] = await courriels(`to:${salarie.email} subject:Rappel`);
    expect(rappel.subject).toBe("Rappel : votre clé est à retirer / Reminder: your key is waiting to be picked up");
    expect(rappel.text).toContain("Lien : http://localhost:3100/cles");
  } finally {
    await delaiDeRetrait(admin, "14");
  }
});
