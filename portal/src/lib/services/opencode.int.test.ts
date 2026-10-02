import { beforeEach, describe, expect, test } from "vitest";
import { resetDb, testDb } from "@/test/db";
import { FakeLiteLLM } from "@/test/fake-litellm";
import { approveKeyRequest } from "./admin-requests";
import { saveCatalogEntry } from "./catalog";
import { blockKey, pickUpKey, replaceKey, revokeOwnKey } from "./keys";
import { configurationOpenCode, type OptionsOpenCode } from "./opencode";
import { createKeyRequest, type KeyRequestInput } from "./requests";

const admin = { uid: "jdupont", email: "jdupont@linagora.com", name: "Jeanne Dupont", isAdmin: true };
const titulaire = { uid: "mmaudet", email: "mmaudet@linagora.com", name: "Michel-Marie Maudet", isAdmin: false };

/** Options de la page, en français, avec l'adresse publique de l'API de production. */
const OPTIONS: OptionsOpenCode = {
  langue: "fr",
  adresseApi: "https://ai-api.linagora.com/v1",
  textes: {
    niveaux: { N1: "N1 Public", N2: "N2 Interne", N3: "N3 Confidentiel", EXP: "Expérimental (bêta)" },
    invite: ({ alias, niveau, equipe }) => `Clé LINAGORA ${alias} (${niveau}, ${equipe}) : `,
  },
  requestIds: null,
  modeleParDefaut: null,
  miseAJour: null,
};

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
});

/** Fiche visible d'un modèle, rédigée par l'admin. */
async function fiche(modelName: string, displayNameFr: string, dataLevel: "N1" | "N2" | "N3" | "EXP", displayNameEn?: string) {
  await saveCatalogEntry(deps, admin, {
    modelName,
    displayNameFr,
    displayNameEn,
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

/**
 * Clé émise du titulaire : demande déposée, approuvée telle quelle pour `jours` jours, puis retirée. Rend l'identifiant
 * de la demande.
 */
async function cleEmise(input: Partial<KeyRequestInput> = {}, jours = 60): Promise<string> {
  const voulue = { ...demande, ...input };
  const { id } = await createKeyRequest(deps, titulaire, voulue);
  await approveKeyRequest(deps, admin, id, { models: voulue.models, budget: 15, budgetDuration: "30d", days: jours, rpmLimit: null, tpmLimit: null });
  await pickUpKey(deps, titulaire, id);
  maintenant = new Date(maintenant.getTime() + 60_000);
  return id;
}

/** Modèles de l'entrée OpenCode d'une clé émise par défaut, pour les modèles donnés. */
async function modelesDeLEntree(models: string[]) {
  await cleEmise({ models });
  const resultat = await configurationOpenCode(deps, titulaire, OPTIONS);
  return JSON.parse(resultat.configuration ?? "null").providers["linagora-n2-r-d-compte-rendu-hebdo"].models;
}

describe("configuration d'OpenCode (ticket #113)", () => {
  test("une clé émise devient une entrée de la configuration, avec ses modèles de conversation", async () => {
    await cleEmise();

    const resultat = await configurationOpenCode(deps, titulaire, OPTIONS);

    expect(JSON.parse(resultat.configuration ?? "null")).toEqual({
      providers: {
        "linagora-n2-r-d-compte-rendu-hebdo": {
          name: "LINAGORA · N2 Interne · R&D · Compte-rendu hebdo",
          package: "@opencode/ai/providers/openai-compatible",
          settings: { baseURL: "https://ai-api.linagora.com/v1" },
          models: {
            "mistral-small": {
              modelID: "mistral-small",
              name: "Mistral Small",
              settings: { apiKey: "{env:LINAGORA_N2_R_D_COMPTE_RENDU_HEBDO_KEY}" },
              capabilities: { tools: true, input: ["text"], output: ["text"] },
              limit: { context: 128000 },
              variants: [],
            },
          },
        },
      },
    });
  });

  test("les modèles d'images, les API de décision et les modèles que la passerelle ne déclare plus sont écartés, avec la raison", async () => {
    litellm.withModel({ modelName: "flux-pro", apiKind: "image" }).withModel({ modelName: "jev", apiKind: "decision" }).withModel({ modelName: "ancien" });
    await fiche("flux-pro", "FLUX.2 [pro]", "N2");
    await fiche("jev", "JEV", "N2");
    await fiche("ancien", "Ancien modèle", "N2");
    await cleEmise({ models: ["mistral-small", "flux-pro", "jev", "ancien"] });
    litellm.models = litellm.models.filter((m) => m.modelName !== "ancien");

    const resultat = await configurationOpenCode(deps, titulaire, OPTIONS);

    expect(resultat.cles).toEqual([
      expect.objectContaining({
        modeles: [{ modelName: "mistral-small", displayName: "Mistral Small", reference: "linagora-n2-r-d-compte-rendu-hebdo/mistral-small" }],
        modelesEcartes: [
          { modelName: "flux-pro", raison: "image" },
          { modelName: "jev", raison: "decision" },
          { modelName: "ancien", raison: "non_declare" },
        ],
      }),
    ]);
    expect(Object.keys(JSON.parse(resultat.configuration ?? "null").providers["linagora-n2-r-d-compte-rendu-hebdo"].models)).toEqual(["mistral-small"]);
  });

  test("en anglais, l'entrée porte le nom anglais du niveau, et chaque modèle le nom anglais de sa fiche, à défaut son nom français", async () => {
    litellm.withModel({ modelName: "codestral" });
    await fiche("codestral", "Codestral (code)", "N2", "Codestral (coding)");
    await cleEmise({ models: ["mistral-small", "codestral"] });
    const niveaux = { N1: "N1 Public", N2: "N2 Internal", N3: "N3 Confidential", EXP: "Experimental (beta)" };

    const resultat = await configurationOpenCode(deps, titulaire, { ...OPTIONS, langue: "en", textes: { ...OPTIONS.textes, niveaux } });

    expect(resultat.cles[0].modeles.map((m) => m.displayName)).toEqual(["Mistral Small", "Codestral (coding)"]);
    const { name, models } = JSON.parse(resultat.configuration ?? "null").providers["linagora-n2-r-d-compte-rendu-hebdo"];
    expect(name).toBe("LINAGORA · N2 Internal · R&D · Compte-rendu hebdo");
    expect([models["mistral-small"].name, models.codestral.name]).toEqual(["Mistral Small", "Codestral (coding)"]);
  });

  test("un modèle qui lit les images les accepte en entrée ; sans contexte déclaré, la configuration n'en donne pas", async () => {
    litellm.withModel({ modelName: "qwen3.8", capabilities: ["images", "raisonnement"], maxInputTokens: null });
    await fiche("qwen3.8", "Qwen 3.8", "N3");
    await cleEmise({ models: ["mistral-small", "qwen3.8"] });

    const resultat = await configurationOpenCode(deps, titulaire, OPTIONS);

    const { models } = JSON.parse(resultat.configuration ?? "null").providers["linagora-n2-r-d-compte-rendu-hebdo"];
    expect(models["qwen3.8"].capabilities).toEqual({ tools: true, input: ["text", "image"], output: ["text"] });
    expect(models["qwen3.8"]).not.toHaveProperty("limit");
    expect(models["mistral-small"].limit).toEqual({ context: 128000 });
  });

  test("une clé bloquée, ou sans aucun modèle utilisable, n'est pas proposée, avec la raison", async () => {
    litellm.withModel({ modelName: "jev", apiKind: "decision" });
    await fiche("jev", "JEV", "EXP");
    const utilisable = await cleEmise();
    const bloquee = await cleEmise({ project: "Bloquée" });
    await blockKey(deps, admin, bloquee);
    const experimentale = await cleEmise({ dataLevel: "EXP", models: ["jev"], project: "Décision" });

    const resultat = await configurationOpenCode(deps, titulaire, OPTIONS);

    expect(resultat.cles.map((c) => c.requestId)).toEqual([utilisable]);
    expect(resultat.clesEcartees).toEqual([
      expect.objectContaining({ requestId: experimentale, raison: "sans_modele" }),
      expect.objectContaining({ requestId: bloquee, raison: "bloquee" }),
    ]);
    expect(Object.keys(JSON.parse(resultat.configuration ?? "null").providers)).toEqual(["linagora-n2-r-d-compte-rendu-hebdo"]);
  });

  test("les clés révoquées ou expirées n'apparaissent pas", async () => {
    const active = await cleEmise();
    await revokeOwnKey(deps, titulaire, await cleEmise({ project: "Révoquée" }));
    await cleEmise({ project: "Expirée" }, 1);
    maintenant = new Date(maintenant.getTime() + 2 * 86_400_000);

    const resultat = await configurationOpenCode(deps, titulaire, OPTIONS);

    expect(resultat.cles.map((c) => c.requestId)).toEqual([active]);
    expect(resultat.clesEcartees).toEqual([]);
  });

  test("depuis une clé, seule cette clé est choisie ; sans choix, toutes les clés proposées le sont ; sans clé choisie, pas de configuration", async () => {
    const hebdo = await cleEmise();
    const revue = await cleEmise({ project: "Revue de code" });
    const choix = async (requestIds: string[] | null) => {
      const resultat = await configurationOpenCode(deps, titulaire, { ...OPTIONS, requestIds });
      const entrees = resultat.configuration === null ? null : Object.keys(JSON.parse(resultat.configuration).providers);
      return { choisies: resultat.cles.filter((c) => c.choisie).map((c) => c.requestId), entrees };
    };

    expect(await choix([hebdo])).toEqual({ choisies: [hebdo], entrees: ["linagora-n2-r-d-compte-rendu-hebdo"] });
    expect(await choix(null)).toEqual({
      choisies: [revue, hebdo],
      entrees: ["linagora-n2-r-d-revue-de-code", "linagora-n2-r-d-compte-rendu-hebdo"],
    });
    expect(await choix([])).toEqual({ choisies: [], entrees: null });
  });

  test("les commandes demandent chaque clé choisie au terminal, en saisie masquée, et ne contiennent jamais la clé", async () => {
    litellm.withTeam({ teamId: "equipe-atelier", teamAlias: "L'atelier", models: [], memberUids: ["mmaudet"] });
    await cleEmise();
    await cleEmise({ teamId: "equipe-atelier", project: null });

    const resultat = await configurationOpenCode(deps, titulaire, OPTIONS);

    const [atelier, hebdo] = resultat.cles.map((c) => c.alias);
    expect(resultat.commandes).toBe(
      [
        `printf '%s' 'Clé LINAGORA ${atelier} (N2 Interne, L'\\''atelier) : '; read -rs K; echo`,
        `opencode service set env LINAGORA_N2_L_ATELIER_KEY "$K"; unset K`,
        `printf '%s' 'Clé LINAGORA ${hebdo} (N2 Interne, R&D) : '; read -rs K; echo`,
        `opencode service set env LINAGORA_N2_R_D_COMPTE_RENDU_HEBDO_KEY "$K"; unset K`,
        "opencode service restart",
      ].join("\n"),
    );
    expect(resultat.verification).toBe("opencode reload && opencode models | grep linagora-");
    for (const { key } of litellm.keys.values()) {
      expect(resultat.commandes).not.toContain(key);
      expect(resultat.configuration).not.toContain(key);
    }
  });

  test("ni le remplacement ni le renouvellement de la clé ne changent son entrée ni sa variable", async () => {
    const origine = await cleEmise();
    const variableEtEntree = async () => {
      const { providers } = JSON.parse((await configurationOpenCode(deps, titulaire, OPTIONS)).configuration ?? "null");
      return Object.entries(providers).map(([id, entree]) => [id, (entree as { models: Record<string, { settings: { apiKey: string } }> }).models["mistral-small"].settings.apiKey]);
    };
    const attendu = [["linagora-n2-r-d-compte-rendu-hebdo", "{env:LINAGORA_N2_R_D_COMPTE_RENDU_HEBDO_KEY}"]];
    expect(await variableEtEntree()).toEqual(attendu);

    await replaceKey(deps, titulaire, origine);
    expect(await variableEtEntree()).toEqual(attendu);

    await cleEmise({ renewsRequestId: origine });
    expect(await variableEtEntree()).toEqual(attendu);
  });

  test("deux clés qui auraient la même entrée sont départagées par la fin de l'identifiant de leur demande", async () => {
    const premiere = await cleEmise();
    const seconde = await cleEmise();

    const resultat = await configurationOpenCode(deps, titulaire, OPTIONS);

    const fin = (id: string) => id.slice(-4);
    expect(Object.keys(JSON.parse(resultat.configuration ?? "null").providers)).toEqual([
      `linagora-n2-r-d-compte-rendu-hebdo-${fin(seconde)}`,
      `linagora-n2-r-d-compte-rendu-hebdo-${fin(premiere)}`,
    ]);
    expect(resultat.commandes).toContain(`opencode service set env LINAGORA_N2_R_D_COMPTE_RENDU_HEBDO_${fin(premiere).toUpperCase()}_KEY "$K"`);
  });

  test("quand la passerelle ne répond pas, aucune configuration n'est produite : la passerelle est dite indisponible", async () => {
    await cleEmise();
    litellm.listModels = async () => {
      throw new Error("LiteLLM injoignable");
    };

    await expect(configurationOpenCode(deps, titulaire, OPTIONS)).rejects.toMatchObject({ code: "passerelle_indisponible" });
  });

  test("quand la passerelle ne donne pas l'état d'une clé émise, aucune configuration n'est produite : la passerelle est dite indisponible", async () => {
    await cleEmise();
    const perdue = await cleEmise({ project: "Perdue" });
    const empreinte = [...litellm.keys.values()].find((k) => k.metadata.request_id === perdue)?.tokenId ?? "";
    litellm.keys.delete(empreinte);

    await expect(configurationOpenCode(deps, titulaire, OPTIONS)).rejects.toMatchObject({ code: "passerelle_indisponible" });
  });
});

describe("faits techniques dans la configuration d'OpenCode (ticket #114)", () => {
  test("la limite de sortie est la sortie maximale déclarée, plafonnée par le contexte", async () => {
    litellm.withModel({ modelName: "devstral", maxInputTokens: 262144, maxOutputTokens: 65536 }).withModel({ modelName: "glm", maxInputTokens: 131072, maxOutputTokens: 943718 });
    await fiche("devstral", "Devstral", "N2");
    await fiche("glm", "GLM", "N2");

    const models = await modelesDeLEntree(["devstral", "glm"]);

    expect(models.devstral.limit).toEqual({ context: 262144, output: 65536 });
    expect(models.glm.limit).toEqual({ context: 131072, output: 131072 });
  });

  test("les variantes sont les efforts déclarés ; aucune pour un modèle sans raisonnement ; omises quand les efforts d'un modèle qui raisonne sont inconnus", async () => {
    litellm
      .withModel({ modelName: "glm", capabilities: ["raisonnement"], reasoningEfforts: ["low", "high", "max"], defaultReasoningEffort: "max" })
      .withModel({ modelName: "kimi", capabilities: ["images", "raisonnement"] });
    await fiche("glm", "GLM", "N2");
    await fiche("kimi", "Kimi", "N2");

    const models = await modelesDeLEntree(["glm", "kimi", "mistral-small"]);

    expect(models.glm.variants).toEqual([
      { id: "low", settings: { reasoningEffort: "low" } },
      { id: "high", settings: { reasoningEffort: "high" } },
      { id: "max", settings: { reasoningEffort: "max" } },
    ]);
    expect(models["mistral-small"].variants).toEqual([]);
    expect(models.kimi).not.toHaveProperty("variants");
  });

  test("les contenus acceptés en entrée et en sortie sont ceux que déclare la passerelle", async () => {
    litellm.withModel({ modelName: "gemini", capabilities: ["images", "audio_video"], inputContents: ["text", "image", "pdf", "audio", "video"], outputContents: ["text"] });
    await fiche("gemini", "Gemini", "N2");

    const models = await modelesDeLEntree(["gemini"]);

    expect(models.gemini.capabilities).toEqual({ tools: true, input: ["text", "image", "pdf", "audio", "video"], output: ["text"] });
  });
});

describe("coût dans la configuration d'OpenCode (ticket #115)", () => {
  test("le coût est en dollars par million de jetons, au taux interne ; le cache sans prix déclaré coûte le prix d'entrée", async () => {
    // Prix en euros de GLM-5.3 (2026-10-02) : 0,5569 € / 3,1463 € par million de jetons, 0,1704 € lus depuis le cache.
    litellm.withModel({ modelName: "glm", inputCostPerToken: 0.0000005569, outputCostPerToken: 0.0000031463, cacheReadCostPerToken: 0.0000001704, fxRateUsdEur: 0.87974 });
    await fiche("glm", "GLM", "N2");

    const models = await modelesDeLEntree(["glm"]);

    expect(models.glm.cost).toEqual({ input: 0.633028, output: 3.5764, cache: { read: 0.193694, write: 0.633028 } });
  });

  test("le palier au-delà de 200 000 jetons s'ajoute quand la passerelle le déclare", async () => {
    litellm.withModel({
      modelName: "gemini",
      inputCostPerToken: 0.0000003,
      outputCostPerToken: 0.0000025,
      cacheReadCostPerToken: 0.00000003,
      cacheWriteCostPerToken: 0.0000000773,
      inputCostPerTokenAbove200k: 0.0000006,
      outputCostPerTokenAbove200k: 0.000005,
      fxRateUsdEur: 0.87974,
    });
    await fiche("gemini", "Gemini", "N2");

    const models = await modelesDeLEntree(["gemini"]);

    const cache = { read: 0.034101, write: 0.0878669 };
    expect(models.gemini.cost).toEqual([
      { input: 0.34101, output: 2.84175, cache },
      { tier: { type: "context", size: 200000 }, input: 0.68202, output: 5.6835, cache },
    ]);
  });

  test("sans taux de change déclaré, la configuration ne donne pas de coût", async () => {
    const models = await modelesDeLEntree(["mistral-small"]);

    expect(models["mistral-small"]).not.toHaveProperty("cost");
  });
});

describe("modèle par défaut et mises à jour d'OpenCode (ticket #116)", () => {
  test("le modèle par défaut, choisi parmi les modèles des clés choisies, est écrit en tête de la configuration ; celui d'une clé décochée est abandonné", async () => {
    const hebdo = await cleEmise();
    const revue = await cleEmise({ project: "Revue de code" });
    const configuration = async (requestIds: string[]) =>
      JSON.parse(
        (await configurationOpenCode(deps, titulaire, { ...OPTIONS, requestIds, modeleParDefaut: "linagora-n2-r-d-revue-de-code/mistral-small" })).configuration ?? "null",
      );

    expect((await configuration([hebdo, revue])).model).toBe("linagora-n2-r-d-revue-de-code/mistral-small");
    expect(await configuration([hebdo])).not.toHaveProperty("model");
  });

  test("la politique de mise à jour choisie est écrite en tête de la configuration ; sans choix, le réglage d'OpenCode reste", async () => {
    await cleEmise();
    const configuration = async (miseAJour: "notify" | "auto" | "disable" | null) =>
      JSON.parse((await configurationOpenCode(deps, titulaire, { ...OPTIONS, miseAJour })).configuration ?? "null");

    expect((await configuration("auto")).update).toBe("auto");
    expect((await configuration("disable")).update).toBe("disable");
    expect(await configuration(null)).not.toHaveProperty("update");
  });
});
