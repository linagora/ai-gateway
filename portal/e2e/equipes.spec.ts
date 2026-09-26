import { expect, test } from "@playwright/test";
import { ADMIN, connecter, courriels } from "./outils";

/* Gestion des équipes par les admins et responsables d'équipe (spécification #35). Admins à notifier : admins-e2e@example.org (.env). */
const suffixe = Date.now().toString(36);
const personne = (n: string) => ({ uid: `equipes-${n}-${suffixe}`, email: `equipes-${n}-${suffixe}@example.org`, name: `Personne ${n} ${suffixe}` });

test("un admin crée puis renomme une équipe ; un nom déjà pris est refusé ; les salariés peuvent la rejoindre (ticket #36)", async ({ browser }) => {
  const admin = await (await connecter(browser, ADMIN)).newPage();
  await admin.goto("/gestion/demandes");
  await admin.getByRole("navigation", { name: "Administration" }).getByRole("link", { name: "Équipes" }).click();
  await expect(admin.getByRole("heading", { level: 1 })).toHaveText("Équipes");

  const nom = `Équipe essai ${suffixe}`;
  await admin.getByLabel("Nom de la nouvelle équipe").fill(nom);
  await admin.getByRole("button", { name: "Créer l'équipe" }).click();
  await expect(admin.getByRole("status")).toHaveText("Équipe créée.");
  await expect(admin.getByRole("row", { name: new RegExp(nom) }).getByRole("cell")).toHaveText([nom, "0", "0"]);

  // Un nom déjà pris, même avec d'autres majuscules, est refusé.
  await admin.getByLabel("Nom de la nouvelle équipe").fill(nom.toUpperCase());
  await admin.getByRole("button", { name: "Créer l'équipe" }).click();
  await expect(admin.getByRole("main").getByRole("alert")).toHaveText(`Le nom ${nom} est déjà pris par une autre équipe.`);

  // Renommage depuis la page de l'équipe.
  await admin.getByRole("link", { name: nom, exact: true }).click();
  await expect(admin.getByRole("heading", { level: 1 })).toHaveText(nom);
  const nouveauNom = `Équipe renommée ${suffixe}`;
  await admin.getByLabel("Nom de l'équipe").fill(nouveauNom);
  await admin.getByRole("button", { name: "Renommer" }).click();
  await expect(admin.getByRole("status")).toHaveText("Équipe renommée.");
  await expect(admin.getByRole("heading", { level: 1 })).toHaveText(nouveauNom);

  // Les admins sont prévenus de la création et du renommage.
  await expect.poll(async () => (await courriels(suffixe)).map((c) => c.subject).sort(), { timeout: 15_000 }).toEqual([
    `[AI GATEWAY] Équipe créée : ${nom} / Team created: ${nom}`,
    `[AI GATEWAY] Équipe renommée : ${nouveauNom} / Team renamed: ${nouveauNom}`,
  ]);
  expect((await courriels(suffixe))[0].to).toEqual(["admins-e2e@example.org"]);

  // La nouvelle équipe est proposée aux salariés qui veulent la rejoindre.
  const salarie = await (await connecter(browser, personne("adhesion"))).newPage();
  await salarie.goto("/demandes/adhesion");
  await expect(salarie.getByLabel("Équipe").locator("option", { hasText: nouveauNom })).toHaveCount(1);
  // La gestion des équipes est réservée aux admins.
  expect((await salarie.goto("/gestion/equipes"))?.status()).toBe(404);
});
