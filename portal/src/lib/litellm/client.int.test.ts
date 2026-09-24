import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, test } from "vitest";
import { createLiteLLMClient } from "./client";

// Contrat vérifié contre le LiteLLM de dev (même version que la production) : npm run test:int
const baseUrl = process.env.LITELLM_TEST_BASE_URL ?? "";
const masterKey = process.env.LITELLM_TEST_MASTER_KEY ?? "";
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
      provider: "openai",
      inputCostPerToken: 0.000001,
      outputCostPerToken: 0.000004,
      pricingCurrency: "EUR",
      dataLevel: "N2",
      hosting: "UE",
      maxInputTokens: 128000,
    });
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

  test("une équipe expose ses modèles et ses membres", async () => {
    const userId = await newUser();
    const { teamId, teamAlias } = await newTeam(["modele-a"]);
    await client.addTeamMember(teamId, userId);
    expect(await client.getTeam(teamId)).toEqual({ teamId, teamAlias, models: ["modele-a"], memberUids: expect.arrayContaining([userId]) });
  });

  test("une équipe inconnue n'est pas trouvée", async () => {
    expect(await client.getTeam(uniqueId("equipe-inconnue"))).toBeNull();
  });

  test("la liste des équipes contient les équipes existantes", async () => {
    const { teamId, teamAlias } = await newTeam(["modele-a"]);
    expect(await client.listTeams()).toContainEqual({ teamId, teamAlias, models: ["modele-a"] });
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
