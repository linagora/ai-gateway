import { expect, test } from "@playwright/test";
import { ADMIN, connecter, demandeApprouvee, enrichirModele, retirerCle } from "./outils";

/* Configuration d'OpenCode à partir des clés émises (ticket #113). La passerelle de développement répond par des modèles simulés. */
const suffixe = Date.now().toString(36);
const personne = (n: string) => ({ uid: `opencode-${n}-${suffixe}`, email: `opencode-${n}-${suffixe}@example.org`, name: `Personne ${n} ${suffixe}` });

test.beforeAll(async ({ browser }) => {
  const context = await connecter(browser, ADMIN);
  await enrichirModele(await context.newPage(), { nom: "dev-public", nomAffiche: "Modèle public", niveau: "N1" });
  await context.close();
});

test("depuis « Mes clés », le titulaire ouvre la configuration d'OpenCode de sa clé : ses modèles y sont, jamais la clé", async ({ browser }) => {
  const salarie = personne("cle");
  const page = await (await connecter(browser, salarie)).newPage();
  await demandeApprouvee(browser, page, salarie, "Essai OpenCode");
  const cle = await retirerCle(page);

  const carte = page.getByRole("region", { name: "Clés émises" }).getByRole("article");
  await carte.getByText("Comment l'utiliser").click();
  await carte.getByRole("link", { name: "Configurer OpenCode avec cette clé" }).click();

  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Configurer OpenCode");
  await expect(page.getByRole("checkbox", { name: new RegExp(`^${salarie.uid}-r-d-essai-opencode-`) })).toBeChecked();
  const configuration = page.getByRole("region", { name: "Configuration" });
  await expect(configuration).toContainText('"linagora-n1-r-d-essai-opencode": {');
  await expect(configuration).toContainText('"name": "LINAGORA · N1 Public · R&D · Essai OpenCode"');
  await expect(configuration).toContainText('"modelID": "dev-public"');
  await expect(configuration).toContainText('"apiKey": "{env:LINAGORA_N1_R_D_ESSAI_OPENCODE_KEY}"');
  await expect(page.getByRole("region", { name: "Enregistrer vos clés" })).toContainText('opencode service set env LINAGORA_N1_R_D_ESSAI_OPENCODE_KEY "$K"');
  expect(await page.content()).not.toContain(cle);
});

test("la page de configuration d'OpenCode existe en anglais", async ({ browser }) => {
  const salarie = personne("anglais");
  const page = await (await connecter(browser, salarie)).newPage();
  await demandeApprouvee(browser, page, salarie, "Essai anglais");
  await retirerCle(page);

  const anglais = await (await connecter(browser, salarie, "en-US")).newPage();
  await anglais.goto("/cles/opencode");
  await expect(anglais.getByRole("heading", { level: 1 })).toHaveText("Set up OpenCode");
  await expect(anglais.getByRole("region", { name: "Configuration" })).toContainText('"name": "LINAGORA · N1 Public · R&D · Essai anglais"');
  await expect(anglais.getByRole("region", { name: "Save your keys" })).toContainText(`LINAGORA key ${salarie.uid}-r-d-essai-anglais-`);
});
