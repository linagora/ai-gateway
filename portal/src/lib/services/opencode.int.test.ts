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
  cles: null,
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
        modeles: [{ modelName: "mistral-small", displayName: "Mistral Small" }],
        modelesEcartes: [
          { modelName: "flux-pro", raison: "images" },
          { modelName: "jev", raison: "decision" },
          { modelName: "ancien", raison: "non_declare" },
        ],
      }),
    ]);
    expect(Object.keys(JSON.parse(resultat.configuration ?? "null").providers["linagora-n2-r-d-compte-rendu-hebdo"].models)).toEqual(["mistral-small"]);
  });

  test("en anglais, chaque modèle porte le nom anglais de sa fiche, à défaut son nom français", async () => {
    litellm.withModel({ modelName: "codestral" });
    await fiche("codestral", "Codestral (code)", "N2", "Codestral (coding)");
    await cleEmise({ models: ["mistral-small", "codestral"] });

    const resultat = await configurationOpenCode(deps, titulaire, { ...OPTIONS, langue: "en" });

    expect(resultat.cles[0].modeles).toEqual([
      { modelName: "mistral-small", displayName: "Mistral Small" },
      { modelName: "codestral", displayName: "Codestral (coding)" },
    ]);
    const { models } = JSON.parse(resultat.configuration ?? "null").providers["linagora-n2-r-d-compte-rendu-hebdo"];
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
    const choix = async (cles: string[] | null) => {
      const resultat = await configurationOpenCode(deps, titulaire, { ...OPTIONS, cles });
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

  test("une clé dont la passerelle ne donne pas l'état n'est pas proposée, avec la raison", async () => {
    const connue = await cleEmise();
    const perdue = await cleEmise({ project: "Perdue" });
    const empreinte = [...litellm.keys.values()].find((k) => k.metadata.request_id === perdue)?.tokenId ?? "";
    litellm.keys.delete(empreinte);

    const resultat = await configurationOpenCode(deps, titulaire, OPTIONS);

    expect(resultat.cles.map((c) => c.requestId)).toEqual([connue]);
    expect(resultat.clesEcartees).toEqual([expect.objectContaining({ requestId: perdue, raison: "etat_inconnu" })]);
  });
});
