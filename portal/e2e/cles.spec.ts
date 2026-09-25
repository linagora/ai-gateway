import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { ADMIN, connecter, demandeApprouvee, enrichirModele } from "./outils";

/* Chantier « Mes clés » (spécification #14). La passerelle de développement répond par des modèles simulés. */
const suffixe = Date.now().toString(36);
const personne = (n: string) => ({ uid: `cles-${n}-${suffixe}`, email: `cles-${n}-${suffixe}@example.org`, name: `Personne ${n} ${suffixe}` });
const PASSERELLE = "http://127.0.0.1:54400/admin/v1/chat/completions";

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
async function retirerCle(page: Page): Promise<string> {
  await page.goto("/cles");
  await page.getByRole("region", { name: "À retirer" }).getByRole("button", { name: "Générer ma clé" }).click();
  const panneau = page.getByRole("region", { name: /Votre nouvelle clé/ });
  const cle = ((await panneau.locator("code").textContent()) ?? "").trim();
  await panneau.getByRole("button", { name: "J'ai copié ma clé" }).click();
  await expect(panneau).toHaveCount(0);
  return cle;
}

/** Statut HTTP d'un appel à la passerelle de développement avec une clé. */
async function appel(request: APIRequestContext, cle: string): Promise<number> {
  const reponse = await request.post(PASSERELLE, { headers: { Authorization: `Bearer ${cle}` }, data: { model: "dev-public", messages: [{ role: "user", content: "Bonjour" }] } });
  return reponse.status();
}

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

test("« Mes clés » s'affiche en anglais", async ({ browser }) => {
  const page = await (await connecter(browser, personne("anglais"), "en-US")).newPage();
  await page.goto("/cles");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("My keys");
  await expect(page.getByRole("navigation").getByRole("link", { name: "My keys" })).toBeVisible();
  await expect(page.getByRole("main")).toContainText("You have no key yet");
});
