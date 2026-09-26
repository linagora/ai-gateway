import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, test } from "vitest";
import { TEST_LITELLM_BASE_URL, TEST_LITELLM_MASTER_KEY } from "@/test/config";
import { createLiteLLMClient } from "./client";

// Contrat vérifié contre le LiteLLM de dev (même version que la production) : npm run test:int
const baseUrl = TEST_LITELLM_BASE_URL;
const masterKey = TEST_LITELLM_MASTER_KEY;
const client = createLiteLLMClient({ baseUrl, masterKey });

const uniqueId = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8)}`;

/** Appels bruts pour préparer et nettoyer les fixtures (hors interface du client). */
async function admin<T = unknown>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${masterKey}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return (await response.json()) as T;
}

const createdUsers: string[] = [];
const createdTeams: string[] = [];
const createdModels: string[] = [];
afterAll(async () => {
  if (createdUsers.length) await admin("POST", "/user/delete", { user_ids: createdUsers });
  if (createdTeams.length) await admin("POST", "/team/delete", { team_ids: createdTeams });
  for (const id of createdModels) await admin("POST", "/model/delete", { id });
});

describe("modèles", () => {
  test("un modèle expose son tarif en euros, son niveau et son hébergement", async () => {
    const modelName = uniqueId("modele");
    const created = await admin<{ model_info: { id: string } }>("POST", "/model/new", {
      model_name: modelName,
      litellm_params: { model: "openai/gpt-4o-mini", api_key: "sk-factice", mock_response: "OK", input_cost_per_token: 0.000001, output_cost_per_token: 0.000004 },
      model_info: { data_level: "N2", pricing_currency: "EUR", hosting: "UE", max_input_tokens: 128000 },
    });
    createdModels.push(created.model_info.id);
    const model = (await client.listModels()).find((m) => m.modelName === modelName);
    expect(model).toEqual({
      modelId: created.model_info.id,
      modelName,
      supplier: null,
      publisher: null,
      capabilities: [],
      hosts: [],
      executionRegion: null,
      apiKind: "conversation",
      imagePrice: null,
      inputCostPerToken: 0.000001,
      outputCostPerToken: 0.000004,
      pricingCurrency: "EUR",
      dataLevel: "N2",
      hosting: "UE",
      maxInputTokens: 128000,
    });
  });

  test("un modèle expose l'éditeur, les capacités, les hébergeurs et la zone d'exécution déclarés par la passerelle", async () => {
    const modelName = uniqueId("modele");
    const created = await admin<{ model_info: { id: string } }>("POST", "/model/new", {
      model_name: modelName,
      litellm_params: { model: "openai/mistralai/mistral-large-2512", api_key: "sk-factice", mock_response: "OK", input_cost_per_token: 0.0000005, output_cost_per_token: 0.0000015 },
      model_info: { fournisseur: "OpenRouter", editeur: "Mistral AI", capacites: ["images", "raisonnement"], hebergeurs: ["Mistral"], zone: "UE", data_level: "N1", pricing_currency: "EUR" },
    });
    createdModels.push(created.model_info.id);
    expect((await client.listModels()).find((m) => m.modelName === modelName)).toMatchObject({
      supplier: "OpenRouter",
      publisher: "Mistral AI",
      capabilities: ["images", "raisonnement"],
      hosts: ["Mistral"],
      executionRegion: "UE",
    });
  });

  test("un modèle déclaré comme API de décision l'expose ; sans déclaration, un modèle est un modèle de conversation", async () => {
    const [decision, conversation] = [uniqueId("decision"), uniqueId("conversation")];
    for (const [modelName, typeApi] of [[decision, { type_api: "decision" }], [conversation, {}]] as const) {
      const created = await admin<{ model_info: { id: string } }>("POST", "/model/new", {
        model_name: modelName,
        litellm_params: { model: "openai/gpt-4o-mini", api_key: "sk-factice", mock_response: "OK", input_cost_per_token: 0.0000001, output_cost_per_token: 0 },
        model_info: { data_level: "EXP", pricing_currency: "EUR", ...typeApi },
      });
      createdModels.push(created.model_info.id);
    }
    const models = await client.listModels();
    expect(models.find((m) => m.modelName === decision)?.apiKind).toBe("decision");
    expect(models.find((m) => m.modelName === conversation)?.apiKind).toBe("conversation");
  });

  test("un modèle d'images l'expose, avec sa capacité de génération et son prix indicatif par image", async () => {
    const modelName = uniqueId("image");
    const created = await admin<{ model_info: { id: string } }>("POST", "/model/new", {
      model_name: modelName,
      litellm_params: { model: "openai/black-forest-labs/flux.2-pro", api_key: "sk-factice", mock_response: "OK", input_cost_per_token: 0, output_cost_per_token: 0.000009063 },
      model_info: {
        fournisseur: "OpenRouter",
        editeur: "Black Forest Labs",
        capacites: ["images", "generation_images"],
        hebergeurs: ["Black Forest Labs"],
        zone: "monde",
        data_level: "N1",
        pricing_currency: "EUR",
        type_api: "image",
        prix_image_eur: 0.0278,
      },
    });
    createdModels.push(created.model_info.id);
    expect((await client.listModels()).find((m) => m.modelName === modelName)).toMatchObject({
      apiKind: "image",
      capabilities: ["images", "generation_images"],
      imagePrice: 0.0278,
      executionRegion: "HORS_UE",
    });
  });

  test("un modèle joint par OpenRouter affiche le fournisseur déclaré, pas la route de LiteLLM", async () => {
    const modelName = uniqueId("modele");
    const created = await admin<{ model_info: { id: string } }>("POST", "/model/new", {
      model_name: modelName,
      litellm_params: { model: "openai/mistralai/ministral-3b-2512", api_key: "sk-factice", mock_response: "OK", input_cost_per_token: 0.0000001, output_cost_per_token: 0.0000001 },
      model_info: { fournisseur: "OpenRouter", data_level: "N1", pricing_currency: "EUR", hosting: "UE" },
    });
    createdModels.push(created.model_info.id);
    expect((await client.listModels()).find((m) => m.modelName === modelName)?.supplier).toBe("OpenRouter");
  });
});

async function newUser(): Promise<string> {
  const userId = uniqueId("u");
  createdUsers.push(userId);
  await client.createUser({ userId, email: `${userId}@example.org` });
  return userId;
}

async function newTeam(models: string[]): Promise<{ teamId: string; teamAlias: string }> {
  const teamAlias = uniqueId("equipe");
  const { team_id: teamId } = await admin<{ team_id: string }>("POST", "/team/new", { team_alias: teamAlias, models });
  createdTeams.push(teamId);
  return { teamId, teamAlias };
}

describe("équipes", () => {
  test("un membre ajouté à une équipe la retrouve dans ses équipes, avec ses modèles", async () => {
    const userId = await newUser();
    const { teamId, teamAlias } = await newTeam(["modele-a", "modele-b"]);
    await client.addTeamMember(teamId, userId);
    expect((await client.getUser(userId))?.teams).toEqual([{ teamId, teamAlias, models: ["modele-a", "modele-b"] }]);
  });

  test("une équipe expose ses modèles et ses membres, sans le membre technique que LiteLLM ajoute à chaque équipe", async () => {
    const userId = await newUser();
    const { teamId, teamAlias } = await newTeam(["modele-a"]);
    await client.addTeamMember(teamId, userId);
    expect(await client.getTeam(teamId)).toEqual({ teamId, teamAlias, models: ["modele-a"], memberUids: [userId] });
  });

  test("une équipe inconnue n'est pas trouvée", async () => {
    expect(await client.getTeam(uniqueId("equipe-inconnue"))).toBeNull();
  });

  test("la liste des équipes contient les équipes existantes, avec leurs membres réels", async () => {
    const userId = await newUser();
    const { teamId, teamAlias } = await newTeam(["modele-a"]);
    await client.addTeamMember(teamId, userId);
    expect(await client.listTeams()).toContainEqual({ teamId, teamAlias, models: ["modele-a"], memberUids: [userId] });
  });

  test("un membre retiré d'une équipe n'en fait plus partie", async () => {
    const userId = await newUser();
    const { teamId } = await newTeam([]);
    await client.addTeamMember(teamId, userId);
    await client.removeTeamMember(teamId, userId);
    expect((await client.getTeam(teamId))?.memberUids).toEqual([]);
  });

  test("une équipe créée par le portail n'a ni modèles ni membres réels ; elle se renomme", async () => {
    const teamAlias = uniqueId("equipe");
    const teamId = await client.createTeam(teamAlias);
    createdTeams.push(teamId);
    expect(await client.getTeam(teamId)).toEqual({ teamId, teamAlias, models: [], memberUids: [] });
    await client.updateTeam(teamId, { alias: `${teamAlias}-renommee` });
    expect((await client.getTeam(teamId))?.teamAlias).toBe(`${teamAlias}-renommee`);
    expect((await client.listTeams()).find((t) => t.teamId === teamId)?.teamAlias).toBe(`${teamAlias}-renommee`);
  });
});

describe("utilisateurs", () => {
  test("un utilisateur inconnu n'est pas trouvé", async () => {
    expect(await client.getUser(uniqueId("inconnu"))).toBeNull();
  });

  test("un utilisateur créé est retrouvé avec son e-mail, sans aucune clé", async () => {
    const userId = uniqueId("u");
    createdUsers.push(userId);
    await client.createUser({ userId, email: `${userId}@example.org` });
    const user = await client.getUser(userId);
    const keys = await admin<{ keys: string[] }>("GET", `/key/list?user_id=${userId}`);
    expect({ email: user?.email, keys: keys.keys.length }).toEqual({ email: `${userId}@example.org`, keys: 0 });
  });
});

describe("clés", () => {
  const createdKeyAliases: string[] = [];
  afterAll(async () => {
    if (createdKeyAliases.length) await admin("POST", "/key/delete", { key_aliases: createdKeyAliases });
  });

  async function titulaire(): Promise<{ userId: string; teamId: string }> {
    const userId = await newUser();
    const { teamId } = await newTeam(["dev-public"]);
    await client.addTeamMember(teamId, userId);
    return { userId, teamId };
  }

  test("une clé générée porte la clé, son empreinte, son alias et sa date d'expiration ; un alias déjà pris est refusé", async () => {
    const { userId, teamId } = await titulaire();
    const alias = uniqueId("cle");
    createdKeyAliases.push(alias);
    const parametres = {
      userId,
      teamId,
      models: ["dev-public"],
      maxBudget: 5,
      budgetDuration: "30d",
      duration: "90d",
      rpmLimit: null,
      tpmLimit: null,
      alias,
      metadata: { request_id: "demande-de-test", data_level: "N1" },
    };
    const avant = Date.now();
    const cle = await client.generateKey(parametres);
    expect(cle.key).toMatch(/^sk-/);
    expect(cle.tokenId).toMatch(/^[0-9a-f]{64}$/);
    expect(cle.alias).toBe(alias);
    expect(cle.expiresAt?.getTime()).toBeGreaterThan(avant + 89 * 86_400_000);
    expect(cle.expiresAt?.getTime()).toBeLessThan(avant + 91 * 86_400_000);
    await expect(client.generateKey(parametres)).rejects.toThrow(/alias/i);
  });

  test("les informations d'une clé se lisent par son empreinte : dépense, budget, remise à zéro, expiration, blocage", async () => {
    const { userId, teamId } = await titulaire();
    const alias = uniqueId("cle");
    createdKeyAliases.push(alias);
    const cle = await client.generateKey({ userId, teamId, models: ["dev-public"], maxBudget: 5, budgetDuration: "30d", duration: "90d", rpmLimit: null, tpmLimit: null, alias, metadata: {} });
    const info = await client.getKeyInfo(cle.tokenId);
    expect(info).toMatchObject({ spend: 0, maxBudget: 5, expiresAt: cle.expiresAt, blocked: false });
    // LiteLLM aligne la remise à zéro sur le calendrier (le 1er du mois pour 30d) : une date future, dans la période.
    expect(info?.budgetResetAt?.getTime()).toBeGreaterThan(Date.now());
    expect(info?.budgetResetAt?.getTime()).toBeLessThanOrEqual(Date.now() + 31 * 86_400_000);
    expect(await client.getKeyInfo("0".repeat(64))).toBeNull();
  });

  test("une clé générée peut reprendre une dépense (remplacement d'une clé perdue)", async () => {
    const { userId, teamId } = await titulaire();
    const alias = uniqueId("cle");
    createdKeyAliases.push(alias);
    const cle = await client.generateKey({ userId, teamId, models: ["dev-public"], maxBudget: 5, budgetDuration: "30d", duration: "90d", rpmLimit: null, tpmLimit: null, alias, metadata: {}, spend: 1.5 });
    expect((await client.getKeyInfo(cle.tokenId))?.spend).toBe(1.5);
  });

  test("une clé générée sans durée n'expire jamais", async () => {
    const { userId, teamId } = await titulaire();
    const alias = uniqueId("cle");
    createdKeyAliases.push(alias);
    const cle = await client.generateKey({ userId, teamId, models: ["dev-public"], maxBudget: 5, budgetDuration: "30d", duration: null, rpmLimit: null, tpmLimit: null, alias, metadata: {} });
    expect(cle.expiresAt).toBeNull();
    expect((await client.getKeyInfo(cle.tokenId))?.expiresAt).toBeNull();
  });

  test("une clé supprimée n'est plus connue, et la passerelle la refuse en quelques secondes", async () => {
    const { userId, teamId } = await titulaire();
    const alias = uniqueId("cle");
    createdKeyAliases.push(alias);
    const cle = await client.generateKey({ userId, teamId, models: ["dev-public"], maxBudget: 5, budgetDuration: "30d", duration: "90d", rpmLimit: null, tpmLimit: null, alias, metadata: {} });
    const appel = () =>
      fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${cle.key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "dev-public", messages: [{ role: "user", content: "Bonjour" }] }),
      }).then((r) => r.status);
    expect(await appel()).toBe(200);
    await client.deleteKey(cle.tokenId);
    expect(await client.getKeyInfo(cle.tokenId)).toBeNull();
    await expect.poll(appel, { timeout: 15_000, interval: 1_000 }).toBe(401);
  });

  test("une clé bloquée est signalée et refusée par la passerelle ; débloquée, elle fonctionne à nouveau", async () => {
    const { userId, teamId } = await titulaire();
    const alias = uniqueId("cle");
    createdKeyAliases.push(alias);
    const cle = await client.generateKey({ userId, teamId, models: ["dev-public"], maxBudget: 5, budgetDuration: "30d", duration: "90d", rpmLimit: null, tpmLimit: null, alias, metadata: {} });
    const appel = () =>
      fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${cle.key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "dev-public", messages: [{ role: "user", content: "Bonjour" }] }),
      }).then((r) => r.status);
    await client.blockKey(cle.tokenId);
    expect((await client.getKeyInfo(cle.tokenId))?.blocked).toBe(true);
    await expect.poll(appel, { timeout: 15_000, interval: 1_000 }).not.toBe(200);
    await client.unblockKey(cle.tokenId);
    expect((await client.getKeyInfo(cle.tokenId))?.blocked).toBe(false);
    await expect.poll(appel, { timeout: 15_000, interval: 1_000 }).toBe(200);
  });
});
