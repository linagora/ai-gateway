import { type Browser, expect, type Locator, type Page, test } from "@playwright/test";
import { ADMIN, ajouterAEquipe, connecter, demandeApprouvee, enrichirModele, type Personne, retirerCle } from "./outils";

/* Configuration de Claude Code à partir des clés émises : un lanceur par clé. La passerelle de développement répond par des modèles simulés. */
const suffixe = Date.now().toString(36);
const personne = (n: string) => ({ uid: `claude-${n}-${suffixe}`, email: `claude-${n}-${suffixe}@example.org`, name: `Personne ${n} ${suffixe}` });

test.beforeAll(async ({ browser }) => {
  const context = await connecter(browser, ADMIN);
  const page = await context.newPage();
  await enrichirModele(page, { nom: "dev-public", nomAffiche: "Modèle public", niveau: "N1" });
  // Comme le catalogue de démonstration : le modèle interne est recommandé pour le code.
  await enrichirModele(page, { nom: "dev-interne", nomAffiche: "Modèle interne", niveau: "N2", casUsage: ["Rédaction et analyse", "Code"], recommandePour: ["Code"] });
  await context.close();
});

/**
 * Le collaborateur, déjà connecté une fois (page ouverte), rejoint R&D et demande une clé N1 pour le modèle public et le
 * modèle interne ; un admin l'approuve telle quelle, puis le collaborateur la retire.
 */
async function cleADeuxModeles(browser: Browser, page: Page, collaborateur: Personne, projet: string): Promise<void> {
  await ajouterAEquipe(collaborateur.uid, "R&D");
  await page.goto("/demandes/nouvelle");
  await page.getByLabel("Équipe").selectOption({ label: "R&D" });
  await page.getByRole("radio", { name: /^N1 Public/ }).check();
  await page.getByLabel(/Modèle public/).check();
  await page.getByLabel(/Modèle interne/).check();
  await page.getByLabel("Motif").fill("Essai de Claude Code");
  await page.getByLabel("Projet ou affaire").fill(projet);
  await page.getByLabel(/Je m'engage/).check();
  await page.getByRole("button", { name: "Envoyer la demande" }).click();
  await expect(page.getByRole("status")).toHaveText("Demande envoyée aux administrateurs.");

  const admin = await (await connecter(browser, ADMIN)).newPage();
  await admin.goto("/gestion/demandes");
  await admin.getByRole("row", { name: new RegExp(`${collaborateur.uid}.*Clé d'API`) }).getByRole("link", { name: "Examiner" }).click();
  await admin.getByLabel("Budget (€)").fill("5");
  await admin.getByLabel("Période du budget (ex. 30d)").fill("30d");
  await admin.getByLabel("Durée de validité").selectOption({ label: "1 mois" });
  await admin.getByRole("button", { name: "Approuver", exact: true }).click();
  await expect(admin.getByRole("status")).toHaveText("Demande approuvée.");
  await admin.context().close();
  await retirerCle(page);
}

test("depuis « Mes clés », le titulaire ouvre la configuration de Claude Code de sa clé : son lanceur lit la clé dans le trousseau, jamais la page", async ({ browser }) => {
  const collaborateur = personne("cle");
  const page = await (await connecter(browser, collaborateur)).newPage();
  await demandeApprouvee(browser, page, collaborateur, "Essai Claude");
  const cle = await retirerCle(page);

  const carte = page.getByRole("region", { name: "Clés émises" }).getByRole("article");
  await carte.getByText("Comment l'utiliser").click();
  await carte.getByRole("link", { name: "Configurer Claude Code avec cette clé" }).click();

  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Configurer Claude Code");
  await expect(page.getByRole("checkbox", { name: new RegExp(`^${collaborateur.uid}-r-d-essai-claude-`) })).toBeChecked();
  await expect(page.getByLabel("Modèle par défaut")).toHaveValue("linagora-n1-r-d-essai-claude/dev-public");
  await expect(page.getByRole("region", { name: "Enregistrer vos clés dans le trousseau" })).toContainText(
    "secret-tool store --label='Clé LINAGORA",
  );
  const lanceurs = page.getByRole("region", { name: "Installer les lanceurs" });
  await expect(lanceurs).toContainText("cat > ~/.local/bin/claude-linagora-n1-r-d-essai-claude <<'FIN_LINAGORA'");
  await expect(lanceurs).toContainText("secret-tool lookup service linagora-ai-gateway cle linagora-n1-r-d-essai-claude)");
  await expect(lanceurs).toContainText("export ANTHROPIC_MODEL='dev-public'");
  await expect(lanceurs).toContainText("export CLAUDE_CODE_MAX_CONTEXT_TOKENS=128000");
  await expect(lanceurs).toContainText("claude-linagora-n1-r-d-essai-claude -p 'Réponds uniquement par le mot OK'");
  const utiliser = page.getByRole("region", { name: "Utiliser Claude Code" });
  await expect(utiliser).toContainText("claude-linagora-n1-r-d-essai-claude");
  // Une clé à un seul modèle : pas d'autre modèle à choisir par /model.
  await expect(utiliser).not.toContainText("/model");
  expect(await page.content()).not.toContain(cle);
});

/** Référence de l'option d'un sélecteur de modèle qui n'est pas choisie, et le nom du modèle qu'elle désigne. */
async function autreModele(select: Locator): Promise<{ reference: string; modele: string }> {
  const choisie = await select.inputValue();
  const valeurs = await select.locator("option").evaluateAll((options) => options.map((o) => (o as HTMLOptionElement).value));
  const reference = valeurs.find((v) => v !== choisie) ?? "";
  return { reference, modele: reference.split("/")[1] };
}

test("le modèle par défaut choisi s'écrit dans le lanceur ; les autres modèles de la clé y sont rappelés pour /model", async ({ browser }) => {
  const collaborateur = personne("defaut");
  const page = await (await connecter(browser, collaborateur)).newPage();
  await cleADeuxModeles(browser, page, collaborateur, "Essai défaut");

  await page.goto("/cles/claude-code");
  const select = page.getByLabel("Modèle par défaut");
  const lanceurs = page.getByRole("region", { name: "Installer les lanceurs" });
  const utiliser = page.getByRole("region", { name: "Utiliser Claude Code" });
  // Sans choix, le modèle par défaut est le premier de la clé ; l'exemple de /model est l'autre.
  await expect(select.locator("option")).toHaveCount(2);
  const premier = (await select.inputValue()).split("/")[1];
  await expect(lanceurs).toContainText(`export ANTHROPIC_MODEL='${premier}'`);
  const { reference, modele } = await autreModele(select);
  await expect(utiliser).toContainText(`/model ${modele}`);

  await select.selectOption(reference);
  await expect(page).toHaveURL(new RegExp(`modele=${encodeURIComponent(reference)}`));
  await expect(lanceurs).toContainText(`export ANTHROPIC_MODEL='${modele}'`);
  await expect(lanceurs).toContainText(`export CLAUDE_CODE_SUBAGENT_MODEL='${modele}'`);
  await expect(lanceurs).toContainText("à choisir dans Claude Code par /model suivi du nom");
  await expect(select).toHaveValue(reference);
  await expect(utiliser).toContainText(`/model ${premier}`);
});

test("avec deux clés, chaque clé a son lanceur et son modèle par défaut, choisi dans sa propre liste", async ({ browser }) => {
  const collaborateur = personne("deux");
  const page = await (await connecter(browser, collaborateur)).newPage();
  await cleADeuxModeles(browser, page, collaborateur, "Deux A");
  await demandeApprouvee(browser, page, collaborateur, "Deux B");
  await retirerCle(page);

  await page.goto("/cles/claude-code");
  const premiere = page.getByLabel(new RegExp(`^Modèle par défaut de la clé ${collaborateur.uid}-r-d-deux-a-`));
  const seconde = page.getByLabel(new RegExp(`^Modèle par défaut de la clé ${collaborateur.uid}-r-d-deux-b-`));
  await expect(premiere.locator("option")).toHaveCount(2);
  expect((await premiere.locator("option").allTextContents()).sort()).toEqual(["Modèle interne", "Modèle public"]);
  await expect(seconde.locator("option")).toHaveText(["Modèle public"]);
  const { reference, modele } = await autreModele(premiere);
  await premiere.selectOption(reference);
  await expect(page).toHaveURL(new RegExp(`modele=${encodeURIComponent(reference)}`));
  expect(new URL(page.url()).searchParams.getAll("modele").sort()).toEqual([reference, "linagora-n1-r-d-deux-b/dev-public"]);

  const lanceurs = page.getByRole("region", { name: "Installer les lanceurs" });
  await expect(lanceurs).toContainText(`export ANTHROPIC_MODEL='${modele}'`);
  const texte = (await lanceurs.locator("pre").first().textContent()) ?? "";
  const lanceur = (entree: string) => texte.slice(texte.indexOf(`claude-${entree} <<'FIN_LINAGORA'`), texte.indexOf(`chmod +x ~/.local/bin/claude-${entree}`));
  expect(lanceur("linagora-n1-r-d-deux-a")).toContain(`export ANTHROPIC_MODEL='${modele}'`);
  expect(lanceur("linagora-n1-r-d-deux-b")).toContain("export ANTHROPIC_MODEL='dev-public'");
});

test("sans clé, la page donne les étapes pour en obtenir une et les modèles recommandés pour le code", async ({ browser }) => {
  const collaborateur = personne("sans-cle");
  const page = await (await connecter(browser, collaborateur)).newPage();

  // Un lien de « Mes clés » mène à la page, même sans clé.
  await page.goto("/cles");
  await page.getByRole("link", { name: "Configurez Claude Code avec vos clés" }).click();
  await expect(page).toHaveURL(/\/cles\/claude-code$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Configurer Claude Code");
  await expect(page.getByText("Pour configurer Claude Code, il vous faut une clé émise avec au moins un modèle de conversation")).toBeVisible();
  await expect(page.getByRole("link", { name: "Faire une demande de clé" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Modèles recommandés pour le code" })).toContainText("Modèle interne · N2 Interne");
});

test("en anglais, le tutoriel guide pas à pas, du lanceur à son utilisation", async ({ browser }) => {
  const collaborateur = personne("anglais");
  const page = await (await connecter(browser, collaborateur)).newPage();
  await demandeApprouvee(browser, page, collaborateur, "Essai anglais");
  await retirerCle(page);

  const anglais = await (await connecter(browser, collaborateur, "en-US")).newPage();
  await anglais.goto("/cles/claude-code");
  await expect(anglais.getByRole("heading", { level: 1 })).toHaveText("Set up Claude Code");
  await expect(anglais.getByRole("heading", { level: 2 })).toHaveText([
    "1Install Claude Code",
    "2Choose your keys",
    "3Save your keys in the keyring",
    "4Install the launchers",
    "5Use Claude Code",
  ]);
  await expect(anglais.getByRole("region", { name: "Install Claude Code" })).toContainText("curl -fsSL https://claude.ai/install.sh | bash");
  await expect(anglais.getByRole("region", { name: "Install Claude Code" })).toContainText("sudo apt install libsecret-tools");
  await expect(anglais.getByRole("region", { name: "Choose your keys" })).toContainText("N3 Confidential: secret code or code of a customer");
  await expect(anglais.getByRole("region", { name: "Save your keys in the keyring" })).toContainText(`LINAGORA key ${collaborateur.uid}-r-d-essai-anglais-`);
  await expect(anglais.getByRole("region", { name: "Install the launchers" })).toContainText("# Claude Code on the LINAGORA gateway, key");
});
