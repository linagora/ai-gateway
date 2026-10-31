import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTranslator } from "next-intl";
import { beforeEach, describe, expect, test } from "vitest";
import type { Langue } from "@/lib/langue";
import { typographieFrancaise } from "@/lib/typographie";
import { resetDb, testDb } from "@/test/db";
import { FakeLiteLLM } from "@/test/fake-litellm";
import en from "../../../messages/en.json";
import fr from "../../../messages/fr.json";
import { approveKeyRequest } from "./admin-requests";
import { saveCatalogEntry } from "./catalog";
import { configurationClaudeCode, type OptionsClaudeCode, type TextesClaudeCode } from "./claude-code";
import { blockKey, pickUpKey } from "./keys";
import { createKeyRequest, type KeyRequestInput } from "./requests";
import { saveSettings } from "./settings";

const admin = { uid: "jdupont", email: "jdupont@linagora.com", name: "Jeanne Dupont", isAdmin: true };
const titulaire = { uid: "mmaudet", email: "mmaudet@linagora.com", name: "Michel-Marie Maudet", isAdmin: false };

/** Espace insécable, que la typographie française du portail met avant « : » et « ; » et dans les guillemets. */
const NB = "\u00a0";

/** Textes du lanceur tirés des messages du portail, comme sur la page : en français, avec la typographie française. */
function textesDe(langue: Langue): TextesClaudeCode {
  const messages = langue === "fr" ? typographieFrancaise(fr) : en;
  const t = createTranslator({ locale: langue, messages, namespace: "claudeCode" });
  return {
    niveaux: messages.domaine.niveaux,
    invite: (cle) => t("invite", cle),
    libelle: (cle) => t("libelle", cle),
    enTete: (cle) => t("script.enTete", cle),
    priorite: t("script.priorite"),
    trafic: t("script.trafic"),
    adresse: t("script.adresse"),
    introuvable: t("script.introuvable"),
    modeleUnique: t("script.modeleUnique"),
    autresModeles: (liste) => t("script.autresModeles", { liste }),
    contexte: t("script.contexte"),
    question: t("script.question"),
  };
}

/** Options de la page, en français, avec l'adresse publique de l'API de production. */
const OPTIONS: OptionsClaudeCode = {
  langue: "fr",
  adresseApi: "https://ai-api.linagora.com/v1",
  textes: textesDe("fr"),
  requestIds: null,
  modelesParDefaut: [],
};

/** Lignes d'un texte du shell. */
const lignes = (texte: string | null) => (texte ?? "").split("\n");

/** Environnement d'un shell lancé par le test, avec son dossier personnel et son chemin des commandes. */
const environnement = (HOME: string, PATH = process.env.PATH ?? ""): NodeJS.ProcessEnv => ({ ...process.env, HOME, PATH });

/** Le shell lit le texte sans erreur de syntaxe (bash -n), sans rien exécuter. */
function syntaxeValide(texte: string) {
  execFileSync("bash", ["-n"], { input: texte });
}

/** Date du jour injectée, avancée d'une minute à chaque retrait : « Mes clés » range les clés de la plus récente à la plus ancienne. */
let maintenant: Date;
let litellm: FakeLiteLLM;
let deps: { db: typeof testDb; litellm: FakeLiteLLM; now: () => Date };

beforeEach(async () => {
  await resetDb();
  maintenant = new Date("2026-10-01T09:00:00Z");
  litellm = new FakeLiteLLM()
    .withModel({ modelName: "mistral-small" })
    .withTeam({ teamId: "equipe-rd", teamAlias: "R&D", models: [], memberUids: ["mmaudet"] });
  litellm.horloge = () => maintenant;
  deps = { db: testDb, litellm, now: () => maintenant };
  await fiche("mistral-small", "Mistral Small", "N2");
  await saveSettings(deps, admin, { default_budget: "20" });
});

/** Fiche visible d'un modèle, rédigée par l'admin. */
async function fiche(modelName: string, displayNameFr: string, dataLevel: "N1" | "N2" | "N3" | "EXP") {
  await saveCatalogEntry(deps, admin, {
    modelName,
    displayNameFr,
    shortDescriptionFr: "…",
    longDescriptionFr: "…",
    useCases: [],
    recommendedFor: [],
    dataLevel,
    visible: true,
  });
}

const demande: KeyRequestInput = {
  teamId: "equipe-rd",
  dataLevel: "N2",
  models: ["mistral-small"],
  justification: "Assistant de code",
  project: "Compte-rendu hebdo",
  requestedBudget: 20,
  requestedDays: 90,
  commitment: true,
};

/** Clé émise du titulaire : demande déposée, approuvée telle quelle, puis retirée. Rend l'identifiant de la demande. */
async function cleEmise(input: Partial<KeyRequestInput> = {}): Promise<string> {
  const voulue = { ...demande, ...input };
  const { id } = await createKeyRequest(deps, titulaire, voulue);
  await approveKeyRequest(deps, admin, id, { models: voulue.models, budget: 15, budgetDuration: "30d", days: 60, rpmLimit: null, tpmLimit: null });
  await pickUpKey(deps, titulaire, id);
  maintenant = new Date(maintenant.getTime() + 60_000);
  return id;
}

/** Lanceur d'une clé, extrait de la commande qui installe les lanceurs. */
function lanceurDe(lanceurs: string | null, entree: string): string {
  const debut = `cat > ~/.local/bin/claude-${entree} <<'FIN_LINAGORA'\n`;
  const texte = lanceurs ?? "";
  const depart = texte.indexOf(debut);
  if (depart < 0) throw new Error(`pas de lanceur pour ${entree}`);
  return texte.slice(depart + debut.length, texte.indexOf("\nFIN_LINAGORA", depart));
}

describe("configuration de Claude Code", () => {
  test("une clé émise devient un lanceur, qui lit la clé dans le trousseau et donne à Claude Code la passerelle, le modèle et son contexte", async () => {
    const requestId = await cleEmise();

    const resultat = await configurationClaudeCode(deps, titulaire, OPTIONS);

    const [cle] = resultat.cles;
    expect(resultat.cles).toEqual([
      expect.objectContaining({
        requestId,
        entree: "linagora-n2-r-d-compte-rendu-hebdo",
        lanceur: "claude-linagora-n2-r-d-compte-rendu-hebdo",
        choisie: true,
        modeles: [{ modelName: "mistral-small", displayName: "Mistral Small", reference: "linagora-n2-r-d-compte-rendu-hebdo/mistral-small" }],
        modelesEcartes: [],
        modeleParDefaut: "linagora-n2-r-d-compte-rendu-hebdo/mistral-small",
      }),
    ]);
    expect(resultat.lanceurs).toBe(
      [
        "mkdir -p ~/.local/bin",
        "cat > ~/.local/bin/claude-linagora-n2-r-d-compte-rendu-hebdo <<'FIN_LINAGORA'",
        "#!/bin/bash",
        `# Claude Code sur la passerelle LINAGORA, clé ${cle.alias} (N2 Interne, R&D, Compte-rendu hebdo)`,
        "set -euo pipefail",
        "# Une clé Anthropic présente dans l'environnement aurait priorité sur la clé LINAGORA",
        "unset ANTHROPIC_API_KEY",
        `# Ni télémétrie, ni rapports d'erreur, ni mise à jour automatique vers Anthropic${NB}: seule la passerelle LINAGORA est appelée${NB}; mettre à jour avec claude update`,
        "export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1",
        `# Adresse de la passerelle, sans /v1${NB}: Claude Code ajoute lui-même /v1/messages`,
        "export ANTHROPIC_BASE_URL='https://ai-api.linagora.com'",
        `ANTHROPIC_AUTH_TOKEN=$(secret-tool lookup service linagora-ai-gateway cle linagora-n2-r-d-compte-rendu-hebdo) && [ -n "$ANTHROPIC_AUTH_TOKEN" ] || { echo 'Clé LINAGORA introuvable dans le trousseau${NB}: enregistrez-la de nouveau depuis la page «${NB}Configurer Claude Code${NB}» du portail.' >&2; exit 1; }`,
        "export ANTHROPIC_AUTH_TOKEN",
        "# Modèle de la clé, pour la conversation, les tâches de fond et les sous-agents",
        "export ANTHROPIC_MODEL='mistral-small'",
        "export ANTHROPIC_DEFAULT_OPUS_MODEL='mistral-small'",
        "export ANTHROPIC_DEFAULT_SONNET_MODEL='mistral-small'",
        "export ANTHROPIC_DEFAULT_HAIKU_MODEL='mistral-small'",
        "export CLAUDE_CODE_SUBAGENT_MODEL='mistral-small'",
        "# Fenêtre de contexte déclarée par la passerelle, la plus petite des modèles de la clé",
        "export CLAUDE_CODE_MAX_CONTEXT_TOKENS=128000",
        'exec claude "$@"',
        "FIN_LINAGORA",
        "chmod +x ~/.local/bin/claude-linagora-n2-r-d-compte-rendu-hebdo",
      ].join("\n"),
    );
    expect(resultat.verification).toBe("claude-linagora-n2-r-d-compte-rendu-hebdo -p 'Réponds uniquement par le mot OK'");
  });

  test("sans contexte déclaré par la passerelle, le lanceur n'en donne pas : Claude Code garde le sien", async () => {
    litellm.withModel({ modelName: "qwen3.8", maxInputTokens: null });
    await fiche("qwen3.8", "Qwen 3.8", "N2");
    await cleEmise({ models: ["qwen3.8"] });

    const { lanceurs } = await configurationClaudeCode(deps, titulaire, OPTIONS);

    const lanceur = lanceurDe(lanceurs, "linagora-n2-r-d-compte-rendu-hebdo");
    expect(lanceur).toContain("export ANTHROPIC_MODEL='qwen3.8'");
    expect(lanceur).not.toContain("CLAUDE_CODE_MAX_CONTEXT_TOKENS");
    expect(lanceur).not.toContain("# Fenêtre de contexte");
    syntaxeValide(lanceur);
    expect(lanceur.split("\n").slice(-2)).toEqual(["export CLAUDE_CODE_SUBAGENT_MODEL='qwen3.8'", 'exec claude "$@"']);
  });

  test("l'adresse de l'API perd son /v1 final, quelle qu'elle soit", async () => {
    await cleEmise();

    const { lanceurs } = await configurationClaudeCode(deps, titulaire, { ...OPTIONS, adresseApi: "http://127.0.0.1:54400/admin/v1" });

    expect(lanceurDe(lanceurs, "linagora-n2-r-d-compte-rendu-hebdo")).toContain("export ANTHROPIC_BASE_URL='http://127.0.0.1:54400/admin'\n");
  });

  test("les commandes enregistrent chaque clé choisie dans le trousseau, en saisie masquée, et ne contiennent jamais la clé", async () => {
    litellm.withTeam({ teamId: "equipe-atelier", teamAlias: "L'atelier", models: [], memberUids: ["mmaudet"] });
    await cleEmise();
    await cleEmise({ teamId: "equipe-atelier", project: null });

    const resultat = await configurationClaudeCode(deps, titulaire, OPTIONS);

    const [atelier, hebdo] = resultat.cles.map((c) => c.alias);
    expect(resultat.commandes).toBe(
      [
        `printf '%s' 'Clé LINAGORA ${atelier} (N2 Interne, L'\\''atelier)${NB}: '; read -rs K; echo`,
        `printf '%s' "$K" | secret-tool store --label='Clé LINAGORA ${atelier} (N2 Interne, L'\\''atelier)' service linagora-ai-gateway cle linagora-n2-l-atelier; unset K`,
        `printf '%s' 'Clé LINAGORA ${hebdo} (N2 Interne, R&D)${NB}: '; read -rs K; echo`,
        `printf '%s' "$K" | secret-tool store --label='Clé LINAGORA ${hebdo} (N2 Interne, R&D)' service linagora-ai-gateway cle linagora-n2-r-d-compte-rendu-hebdo; unset K`,
      ].join("\n"),
    );
    expect(lanceurDe(resultat.lanceurs, "linagora-n2-l-atelier")).toContain(`# Claude Code sur la passerelle LINAGORA, clé ${atelier} (N2 Interne, L'atelier)\n`);
    expect(resultat.verification).toBe(
      ["claude-linagora-n2-l-atelier -p 'Réponds uniquement par le mot OK'", "claude-linagora-n2-r-d-compte-rendu-hebdo -p 'Réponds uniquement par le mot OK'"].join("\n"),
    );
    for (const { key } of litellm.keys.values()) {
      expect(resultat.commandes).not.toContain(key);
      expect(resultat.lanceurs).not.toContain(key);
      expect(resultat.verification).not.toContain(key);
    }
    syntaxeValide(resultat.commandes ?? "");
  });

  test("le modèle par défaut de chaque clé est sa référence parmi ceux demandés, sinon son premier modèle ; les autres sont rappelés pour /model", async () => {
    litellm.withModel({ modelName: "devstral", maxInputTokens: 262144 }).withModel({ modelName: "glm" });
    await fiche("devstral", "Devstral", "N2");
    await fiche("glm", "GLM", "N2");
    await cleEmise({ models: ["mistral-small", "devstral", "glm"] });
    await cleEmise({ project: "Revue de code", models: ["mistral-small", "devstral"] });

    const resultat = await configurationClaudeCode(deps, titulaire, {
      ...OPTIONS,
      // Le modèle par défaut de la revue de code, et un modèle d'une autre clé qui n'est pas dans la clé hebdo.
      modelesParDefaut: ["linagora-n2-r-d-revue-de-code/devstral", "linagora-n2-r-d-autre/glm"],
    });

    expect(resultat.cles.map((c) => [c.entree, c.modeleParDefaut])).toEqual([
      ["linagora-n2-r-d-revue-de-code", "linagora-n2-r-d-revue-de-code/devstral"],
      ["linagora-n2-r-d-compte-rendu-hebdo", "linagora-n2-r-d-compte-rendu-hebdo/mistral-small"],
    ]);
    const autres = `# Modèle par défaut, pour la conversation, les tâches de fond et les sous-agents${NB}; autres modèles de la clé, à choisir dans Claude Code par /model suivi du nom${NB}: `;
    const revue = lanceurDe(resultat.lanceurs, "linagora-n2-r-d-revue-de-code");
    expect(revue).toContain(`${autres}mistral-small\n`);
    for (const variable of ["ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL"]) {
      expect(revue).toContain(`export ${variable}='devstral'\n`);
    }
    const hebdo = lanceurDe(resultat.lanceurs, "linagora-n2-r-d-compte-rendu-hebdo");
    expect(hebdo).toContain(`${autres}devstral, glm\n`);
    expect(hebdo).toContain("export ANTHROPIC_MODEL='mistral-small'\n");
  });

  test("la fenêtre de contexte est la plus petite des contextes déclarés des modèles de la clé, que /model peut choisir en cours de session ; un modèle par défaut sans contexte déclaré n'en reçoit pas", async () => {
    litellm.withModel({ modelName: "devstral", maxInputTokens: 262144 }).withModel({ modelName: "qwen3.8", maxInputTokens: null }).withModel({ modelName: "glm", maxInputTokens: 200000 });
    await fiche("devstral", "Devstral", "N2");
    await fiche("qwen3.8", "Qwen 3.8", "N2");
    await fiche("glm", "GLM", "N2");
    await cleEmise({ models: ["qwen3.8", "devstral", "glm"] });
    const lanceurAvec = async (modele: string) => {
      const { lanceurs } = await configurationClaudeCode(deps, titulaire, { ...OPTIONS, modelesParDefaut: [`linagora-n2-r-d-compte-rendu-hebdo/${modele}`] });
      return lanceurDe(lanceurs, "linagora-n2-r-d-compte-rendu-hebdo");
    };

    // Devstral par défaut : le plus petit des contextes déclarés, celui de GLM ; Qwen n'en déclare pas.
    const devstral = await lanceurAvec("devstral");
    expect(devstral).toContain("export ANTHROPIC_MODEL='devstral'\n");
    expect(devstral).toContain("export CLAUDE_CODE_MAX_CONTEXT_TOKENS=200000\n");
    // Qwen par défaut : pas de contexte deviné d'après les autres modèles de la clé.
    const qwen = await lanceurAvec("qwen3.8");
    expect(qwen).toContain("export ANTHROPIC_MODEL='qwen3.8'\n");
    expect(qwen).not.toContain("CLAUDE_CODE_MAX_CONTEXT_TOKENS");
    syntaxeValide(qwen);
  });

  test("depuis une clé, seule cette clé a un lanceur ; sans choix, toutes les clés proposées en ont un ; sans clé choisie, rien n'est produit", async () => {
    const hebdo = await cleEmise();
    const revue = await cleEmise({ project: "Revue de code" });
    const choix = async (requestIds: string[] | null) => {
      const resultat = await configurationClaudeCode(deps, titulaire, { ...OPTIONS, requestIds });
      const lanceurs = resultat.lanceurs === null ? null : [...resultat.lanceurs.matchAll(/^chmod \+x ~\/\.local\/bin\/(.+)$/gm)].map((m) => m[1]);
      return { choisies: resultat.cles.filter((c) => c.choisie).map((c) => c.requestId), lanceurs, commandes: resultat.commandes?.split("\n").length ?? null };
    };

    expect(await choix([hebdo])).toEqual({ choisies: [hebdo], lanceurs: ["claude-linagora-n2-r-d-compte-rendu-hebdo"], commandes: 2 });
    expect(await choix(null)).toEqual({
      choisies: [revue, hebdo],
      lanceurs: ["claude-linagora-n2-r-d-revue-de-code", "claude-linagora-n2-r-d-compte-rendu-hebdo"],
      commandes: 4,
    });
    expect(await choix([])).toEqual({ choisies: [], lanceurs: null, commandes: null });
    expect((await configurationClaudeCode(deps, titulaire, { ...OPTIONS, requestIds: [] })).verification).toBeNull();
  });

  test("en anglais, les commandes, les commentaires et le message d'erreur du lanceur sont ceux des messages anglais du portail", async () => {
    await cleEmise();

    const resultat = await configurationClaudeCode(deps, titulaire, { ...OPTIONS, langue: "en", textes: textesDe("en") });

    const { alias } = resultat.cles[0];
    expect(resultat.commandes).toBe(
      [
        `printf '%s' 'LINAGORA key ${alias} (N2 Internal, R&D): '; read -rs K; echo`,
        `printf '%s' "$K" | secret-tool store --label='LINAGORA key ${alias} (N2 Internal, R&D)' service linagora-ai-gateway cle linagora-n2-r-d-compte-rendu-hebdo; unset K`,
      ].join("\n"),
    );
    const lanceur = lanceurDe(resultat.lanceurs, "linagora-n2-r-d-compte-rendu-hebdo");
    expect(lanceur).toContain(`# Claude Code on the LINAGORA gateway, key ${alias} (N2 Internal, R&D, Compte-rendu hebdo)\n`);
    expect(lanceur).toContain("# No telemetry, error reports or automatic updates to Anthropic: only the LINAGORA gateway is called; update with claude update\n");
    expect(lanceur).toContain("# Gateway address, without /v1: Claude Code adds /v1/messages itself\n");
    expect(lanceur).toContain(`&& [ -n "$ANTHROPIC_AUTH_TOKEN" ] || { echo 'LINAGORA key not found in the keyring: save it again from the "Set up Claude Code" page of the portal.' >&2; exit 1; }\n`);
    expect(lanceur).toContain("# Model of the key, for the conversation, background tasks and subagents\n");
    expect(resultat.verification).toBe("claude-linagora-n2-r-d-compte-rendu-hebdo -p 'Reply with the word OK only'");
  });

  test("les modèles qui ne sont pas de conversation, ou que la passerelle ne déclare plus, sont écartés, avec la raison", async () => {
    litellm.withModel({ modelName: "flux-pro", apiKind: "image" }).withModel({ modelName: "bge-m3", apiKind: "embeddings", dimensions: 1024 }).withModel({ modelName: "ancien" });
    await fiche("flux-pro", "FLUX.2 [pro]", "N2");
    await fiche("bge-m3", "BGE-M3", "N2");
    await fiche("ancien", "Ancien modèle", "N2");
    await cleEmise({ models: ["flux-pro", "mistral-small", "bge-m3", "ancien"] });
    litellm.models = litellm.models.filter((m) => m.modelName !== "ancien");

    const resultat = await configurationClaudeCode(deps, titulaire, OPTIONS);

    expect(resultat.cles).toEqual([
      expect.objectContaining({
        modeles: [{ modelName: "mistral-small", displayName: "Mistral Small", reference: "linagora-n2-r-d-compte-rendu-hebdo/mistral-small" }],
        modelesEcartes: [
          { modelName: "flux-pro", raison: "image" },
          { modelName: "bge-m3", raison: "embeddings" },
          { modelName: "ancien", raison: "non_declare" },
        ],
        modeleParDefaut: "linagora-n2-r-d-compte-rendu-hebdo/mistral-small",
      }),
    ]);
    const lanceur = lanceurDe(resultat.lanceurs, "linagora-n2-r-d-compte-rendu-hebdo");
    expect(lanceur).toContain("export ANTHROPIC_MODEL='mistral-small'\n");
    expect(lanceur).not.toMatch(/flux-pro|bge-m3|ancien/);
  });

  test("une clé bloquée, ou sans aucun modèle de conversation, n'a pas de lanceur, avec la raison", async () => {
    litellm.withModel({ modelName: "jev", apiKind: "decision" });
    await fiche("jev", "JEV", "EXP");
    const utilisable = await cleEmise();
    const bloquee = await cleEmise({ project: "Bloquée" });
    await blockKey(deps, admin, bloquee);
    const experimentale = await cleEmise({ dataLevel: "EXP", models: ["jev"], project: "Décision" });

    const resultat = await configurationClaudeCode(deps, titulaire, OPTIONS);

    expect(resultat.cles.map((c) => c.requestId)).toEqual([utilisable]);
    expect(resultat.clesEcartees).toEqual([
      expect.objectContaining({ requestId: experimentale, raison: "sans_modele" }),
      expect.objectContaining({ requestId: bloquee, raison: "bloquee" }),
    ]);
    expect(resultat.lanceurs?.match(/^chmod /gm)).toHaveLength(1);
  });

  test("un projet qui contiendrait des retours à la ligne ne ferme pas le document en ligne : il reste dans une seule ligne de commentaire", async () => {
    await cleEmise({ project: "Essai\nFIN_LINAGORA\necho pwned" });

    const { cles, lanceurs, commandes } = await configurationClaudeCode(deps, titulaire, OPTIONS);

    const { entree, alias } = cles[0];
    const lanceur = lanceurDe(lanceurs, entree);
    expect(lignes(lanceur).filter((l) => l.startsWith("# Claude Code sur la passerelle LINAGORA"))).toEqual([
      `# Claude Code sur la passerelle LINAGORA, clé ${alias} (N2 Interne, R&D, Essai FIN_LINAGORA echo pwned)`,
    ]);
    expect(lignes(lanceur)).not.toContain("echo pwned");
    // La seule ligne FIN_LINAGORA de la commande est celle qui termine le lanceur, juste avant le chmod.
    const toutes = lignes(lanceurs);
    expect(toutes.filter((l) => l === "FIN_LINAGORA")).toHaveLength(1);
    expect(toutes.at(-2)).toBe("FIN_LINAGORA");
    expect(toutes.at(-1)).toBe(`chmod +x ~/.local/bin/claude-${entree}`);
    expect(lignes(commandes)).toHaveLength(2);

    // Exécutée pour de bon dans un dossier personnel jetable, la commande n'écrit que le lanceur et n'exécute rien d'autre.
    const maison = mkdtempSync(join(tmpdir(), "claude-code-"));
    try {
      const sortie = execFileSync("bash", [], { input: lanceurs ?? "", env: environnement(maison), encoding: "utf8" });
      expect(sortie).toBe("");
      expect(readFileSync(join(maison, ".local/bin", `claude-${entree}`), "utf8")).toBe(`${lanceur}\n`);
    } finally {
      rmSync(maison, { recursive: true, force: true });
    }
  });

  test("chaque lanceur produit est un script bash valide, en français comme en anglais, et la commande qui les installe aussi", async () => {
    litellm.withTeam({ teamId: "equipe-atelier", teamAlias: "L'atelier", models: [], memberUids: ["mmaudet"] });
    litellm.withModel({ modelName: "devstral", maxInputTokens: null });
    await fiche("devstral", "Devstral", "N2");
    await cleEmise({ models: ["mistral-small", "devstral"] });
    await cleEmise({ teamId: "equipe-atelier", project: "L'outil « maison »", models: ["devstral"] });

    for (const langue of ["fr", "en"] as const) {
      const resultat = await configurationClaudeCode(deps, titulaire, { ...OPTIONS, langue, textes: textesDe(langue) });
      expect(resultat.cles).toHaveLength(2);
      syntaxeValide(resultat.lanceurs ?? "");
      syntaxeValide(resultat.commandes ?? "");
      syntaxeValide(resultat.verification ?? "");
      for (const cle of resultat.cles) syntaxeValide(lanceurDe(resultat.lanceurs, cle.entree));
    }
  });

  test("le lanceur refuse une clé absente du trousseau, ou vide, avec le message d'erreur", async () => {
    await cleEmise();
    const { lanceurs } = await configurationClaudeCode(deps, titulaire, OPTIONS);
    const lanceur = lanceurDe(lanceurs, "linagora-n2-r-d-compte-rendu-hebdo");
    const maison = mkdtempSync(join(tmpdir(), "claude-code-"));
    const chemin = `${join(maison, "bin")}:${process.env.PATH ?? ""}`;
    /** Lance le lanceur avec un secret-tool simulé, dont le corps est donné. */
    const lancer = (secretTool: string) => {
      execFileSync("bash", ["-c", `mkdir -p "$HOME/bin" && printf '#!/bin/bash\\n%s\\n' "$1" > "$HOME/bin/secret-tool" && chmod +x "$HOME/bin/secret-tool"`, "-", secretTool], {
        env: environnement(maison, chemin),
      });
      try {
        execFileSync("bash", ["-c", lanceur], { env: environnement(maison, chemin), encoding: "utf8", stdio: "pipe" });
        return { code: 0, erreur: "" };
      } catch (e) {
        const { status, stderr } = e as { status: number; stderr: string };
        return { code: status, erreur: stderr };
      }
    };
    try {
      const refus = { code: 1, erreur: `Clé LINAGORA introuvable dans le trousseau${NB}: enregistrez-la de nouveau depuis la page «${NB}Configurer Claude Code${NB}» du portail.\n` };
      // Sans clé enregistrée, secret-tool sort en erreur ; une clé enregistrée vide est rendue vide, sans erreur.
      expect(lancer("exit 1")).toEqual(refus);
      expect(lancer("exit 0")).toEqual(refus);
    } finally {
      rmSync(maison, { recursive: true, force: true });
    }
  });

  test("quand la passerelle ne répond pas, rien n'est produit : la passerelle est dite indisponible", async () => {
    await cleEmise();
    litellm.listModels = async () => {
      throw new Error("LiteLLM injoignable");
    };

    await expect(configurationClaudeCode(deps, titulaire, OPTIONS)).rejects.toMatchObject({ code: "passerelle_indisponible" });
  });
});
