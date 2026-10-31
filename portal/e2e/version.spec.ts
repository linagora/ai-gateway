import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { connecter } from "./outils";

/* Version publiée du projet, celle de package.json, en pied de page avec le lien vers ses notes sur GitHub. */
const { version } = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as { version: string };
const suffixe = Date.now().toString(36);
const personne = { uid: `version-${suffixe}`, email: `version-${suffixe}@example.org`, name: `Personne version ${suffixe}` };

test("le pied de page donne la version publiée, avec le lien vers ses notes", async ({ browser }) => {
  expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  for (const [langue, notes] of [["fr-FR", "notes de version"], ["en-US", "release notes"]] as const) {
    const context = await connecter(browser, personne, langue);
    const page = await context.newPage();
    await page.goto("/catalogue");
    const lien = page.getByRole("contentinfo").getByRole("link", { name: `AI Gateway ${version} (${notes})` });
    await expect(lien).toHaveAttribute("href", `https://github.com/linagora/ai-gateway/releases/tag/v${version}`);
    await context.close();
  }
});

test("sans connexion, la version n'est pas donnée", async ({ page }) => {
  await page.goto("/connexion");
  await expect(page.getByRole("button", { name: /LemonLDAP/ })).toBeVisible();
  await expect(page.getByRole("contentinfo")).toHaveCount(0);
});
