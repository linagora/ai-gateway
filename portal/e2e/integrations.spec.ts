import { createHash, generateKeyPairSync } from "node:crypto";
import { expect, test } from "@playwright/test";
import { ADMIN, connecter, courriels } from "./outils";

/*
 * Onglet « Intégrations » (spécification #71, ticket #74) : un admin déclare une intégration, désactivée, lui ajoute une
 * clé publique, règle son périmètre, l'active puis la désactive ; chaque changement est annoncé à tous les admins
 * (admins-e2e@example.org, .env). Un collaborateur n'y a pas accès.
 */
const suffixe = Date.now().toString(36);
const personne = (n: string) => ({ uid: `integrations-${n}-${suffixe}`, email: `integrations-${n}-${suffixe}@example.org`, name: `Personne ${n} ${suffixe}` });

test("un admin déclare une intégration, lui ajoute une clé publique, règle son périmètre, l'active puis la désactive ; chaque changement est annoncé aux admins", async ({ browser }) => {
  const id = `e2e-${suffixe}`;
  const nom = `Intégration ${suffixe}`;
  const admin = await (await connecter(browser, ADMIN)).newPage();
  await admin.goto("/gestion/demandes");
  await admin.getByRole("navigation", { name: "Administration" }).getByRole("link", { name: "Intégrations" }).click();
  await expect(admin.getByRole("heading", { level: 1 })).toHaveText("Intégrations");

  // Déclaration : une adresse invalide est refusée, puis l'intégration est créée désactivée.
  const declarer = async (adresses: string) => {
    const formulaire = admin.getByRole("form", { name: "Déclarer une intégration" });
    await formulaire.getByLabel("Identifiant").fill(id);
    await formulaire.getByLabel("Nom").fill(nom);
    await formulaire.getByRole("checkbox", { name: /^Lecture/ }).check();
    await formulaire.getByRole("checkbox", { name: /^Demandes/ }).check();
    await formulaire.getByLabel("Adresses IP et plages CIDR").fill(adresses);
    await formulaire.getByRole("button", { name: "Déclarer l'intégration" }).click();
  };
  await declarer("203.0.113.10\n10.0.0.300");
  await expect(admin.getByRole("main").getByRole("alert")).toHaveText("Adresse IP ou plage CIDR invalide : 10.0.0.300.");
  await declarer("203.0.113.10\n2001:db8::/32");
  await expect(admin.getByRole("status")).toHaveText("Intégration déclarée, désactivée : ajoutez sa clé publique, puis activez-la après la recette.");
  const desactivees = admin.getByRole("region", { name: /^Intégrations désactivées/ });
  const fiche = admin.getByRole("region", { name: nom });
  await expect(desactivees.getByRole("region", { name: nom })).toBeVisible();
  await expect(fiche).toContainText("Aucune clé : aucun jeton de l'intégration n'est accepté.");
  await expect(fiche.getByLabel("Adresses IP et plages CIDR")).toHaveValue("203.0.113.10\n2001:db8::/32");
  await expect(fiche.getByLabel("Plafond (requêtes par minute)")).toHaveValue("120");

  // L'identifiant est unique.
  await declarer("203.0.113.10");
  await expect(admin.getByRole("main").getByRole("alert")).toHaveText(`L'identifiant ${id} est déjà pris par une autre intégration.`);

  // Clé publique : une clé privée est refusée ; la clé publique est enregistrée, avec son empreinte.
  await admin.goto(`/gestion/integrations?integration=${id}`);
  const paire = generateKeyPairSync("ed25519");
  const ajouterCle = async (pem: string) => {
    const formulaire = fiche.getByRole("form", { name: `Ajouter une clé publique ${nom}` });
    await formulaire.getByLabel("Identifiant de clé (kid)").fill("cle-1");
    await formulaire.getByLabel("Algorithme").selectOption({ label: "EdDSA (Ed25519)" });
    await formulaire.getByLabel("Clé publique (PEM)").fill(pem);
    await formulaire.getByRole("button", { name: "Ajouter la clé" }).click();
  };
  await ajouterCle(paire.privateKey.export({ type: "pkcs8", format: "pem" }).toString());
  await expect(admin.getByRole("main").getByRole("alert")).toHaveText("C'est une clé privée : elle ne doit jamais quitter l'intégration. Collez sa clé publique seule.");
  await ajouterCle(paire.publicKey.export({ type: "spki", format: "pem" }).toString());
  await expect(admin.getByRole("status")).toHaveText("Clé publique ajoutée.");
  const empreinte = `SHA256:${createHash("sha256").update(paire.publicKey.export({ type: "spki", format: "der" })).digest("base64").replace(/=+$/, "")}`;
  await expect(fiche.getByRole("row", { name: /cle-1/ })).toContainText(empreinte);

  // Réglages : le périmètre se réduit à la lecture, le plafond baisse.
  const reglages = fiche.getByRole("form", { name: `Réglages ${nom}` });
  await reglages.getByRole("checkbox", { name: /^Demandes/ }).uncheck();
  await reglages.getByLabel("Plafond (requêtes par minute)").fill("60");
  await reglages.getByRole("button", { name: "Enregistrer" }).click();
  await expect(admin.getByRole("status")).toHaveText("Intégration enregistrée.");
  await expect(fiche.getByRole("form", { name: `Réglages ${nom}` }).getByRole("checkbox", { name: /^Demandes/ })).not.toBeChecked();

  // Activation : l'intégration passe parmi les actives ; désactivation d'un clic ; aucune suppression.
  await fiche.getByRole("button", { name: "Activer" }).click();
  await expect(admin.getByRole("status")).toHaveText("Intégration activée.");
  await expect(admin.getByRole("region", { name: "Intégrations actives" }).getByRole("region", { name: nom })).toBeVisible();
  await expect(fiche.getByRole("button", { name: /Supprimer/ })).toHaveCount(0);
  await fiche.getByRole("button", { name: "Désactiver" }).click();
  await expect(admin.getByRole("status")).toHaveText("Intégration désactivée : ses appels sont refusés.");
  await expect(desactivees.getByRole("region", { name: nom })).toBeVisible();

  // Mise hors service de la clé, après confirmation : elle reste inscrite parmi les clés hors service.
  await fiche.getByRole("row", { name: /cle-1/ }).getByText("Mettre hors service", { exact: true }).click();
  await fiche.getByRole("button", { name: "Mettre hors service la clé cle-1" }).click();
  await expect(admin.getByRole("status")).toHaveText("Clé publique mise hors service : les jetons qu'elle signe sont désormais refusés.");
  await expect(fiche).toContainText("Aucune clé : aucun jeton de l'intégration n'est accepté.");
  await expect(fiche.getByText("Clés hors service (1)")).toBeVisible();

  // Sans rechargement ciblé, une intégration désactivée est repliée.
  await admin.goto("/gestion/integrations");
  await expect(admin.getByRole("region", { name: nom })).toBeHidden();

  // Chaque changement est annoncé à tous les admins ; l'ajout de la clé donne son empreinte.
  const bilingue = (fr: string, en: string) => `[AI GATEWAY] ${fr} / ${en}`;
  await expect
    .poll(async () => (await courriels(id)).map((c) => c.subject).sort(), { timeout: 15_000 })
    .toEqual(
      [
        bilingue(`Intégration déclarée : ${nom}`, `Integration declared: ${nom}`),
        bilingue(`Clé publique ajoutée à l'intégration ${nom}`, `Public key added to the integration ${nom}`),
        bilingue(`Intégration modifiée : ${nom}`, `Integration updated: ${nom}`),
        bilingue(`Intégration activée : ${nom}`, `Integration enabled: ${nom}`),
        bilingue(`Intégration désactivée : ${nom}`, `Integration disabled: ${nom}`),
        bilingue(`Clé publique mise hors service pour l'intégration ${nom}`, `Public key retired for the integration ${nom}`),
      ].sort(),
    );
  const recus = await courriels(id);
  expect(recus.every((c) => c.to.join() === "admins-e2e@example.org")).toBe(true);
  expect(recus.find((c) => c.subject.includes("Clé publique ajoutée"))?.text).toContain(empreinte);
  expect(recus.find((c) => c.subject.includes("Intégration modifiée"))?.text).toContain("- Périmètre : lecture (auparavant : lecture, demandes)");
});

test("un collaborateur n'a ni l'onglet ni la page des intégrations", async ({ browser }) => {
  const collaborateur = await (await connecter(browser, personne("collaborateur"))).newPage();
  await collaborateur.goto("/");
  await expect(collaborateur.getByRole("link", { name: /^Gestion/ })).toHaveCount(0);
  expect((await collaborateur.goto("/gestion/integrations"))?.status()).toBe(404);
});
