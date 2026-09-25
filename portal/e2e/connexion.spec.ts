import { expect, test } from "@playwright/test";

/* Page de connexion du portail (ticket #12) : traduite, elle mène au SSO puis à l'adresse demandée. */
const suffixe = Date.now().toString(36);

for (const [navigateur, textes] of [
  ["fr-FR", { titre: "Connexion au Portail IA", bouton: "Se connecter avec LemonLDAP::NG", arrivee: "Mes demandes" }],
  ["en-US", { titre: "Sign in to the AI Portal", bouton: "Sign in with LemonLDAP::NG", arrivee: "My requests" }],
] as const) {
  test(`sans session, une page du portail mène à la page de connexion traduite, puis au SSO et à la page demandée (${navigateur})`, async ({ browser }) => {
    const context = await browser.newContext({ locale: navigateur });
    const page = await context.newPage();
    await page.goto("/demandes");
    await expect(page).toHaveURL(/\/connexion\?callbackUrl=/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(textes.titre);
    const logo = page.getByRole("banner").getByRole("img", { name: "Linagora" });
    await expect(logo).toBeVisible();
    expect(await logo.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
    await expect(page.getByRole("navigation")).toHaveCount(0);
    await page.getByRole("button", { name: textes.bouton }).click();
    const uid = `connexion-${navigateur}-${suffixe}`;
    await page.locator('input[name="username"]').fill(uid);
    await page.locator('textarea[name="claims"]').fill(JSON.stringify({ email: `${uid}@example.org`, name: "Personne connexion" }));
    await page.getByRole("button", { name: "Sign-in" }).click();
    await expect(page).toHaveURL(/\/demandes$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(textes.arrivee);
    await context.close();
  });
}

test("un échec de connexion est expliqué dans la langue du navigateur", async ({ browser }) => {
  const context = await browser.newContext({ locale: "en-US" });
  const page = await context.newPage();
  await page.goto("/connexion?error=Configuration");
  await expect(page.getByRole("alert")).toHaveText("Sign-in failed. Try again; if the problem persists, contact a portal administrator.");
  await expect(page.getByRole("button", { name: "Sign in with LemonLDAP::NG" })).toBeVisible();
  await context.close();
});
