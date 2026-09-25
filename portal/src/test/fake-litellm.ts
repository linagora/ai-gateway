import type { LiteLLMClient, LiteLLMModel, LiteLLMTeam, LiteLLMUser } from "@/lib/litellm/client";

/**
 * LiteLLM simulé en mémoire pour tester les cas d'usage (frontière avec un système externe).
 * Se comporte comme le vrai sur les points vérifiés par les tests de contrat (client.int.test.ts).
 */
export class FakeLiteLLM implements LiteLLMClient {
  readonly users = new Map<string, { email: string }>();
  readonly teams = new Map<string, LiteLLMTeam>();
  models: LiteLLMModel[] = [];

  async getUser(userId: string): Promise<LiteLLMUser | null> {
    const user = this.users.get(userId);
    if (!user) return null;
    const teams = [...this.teams.values()]
      .filter((t) => t.memberUids.includes(userId))
      .map(({ teamId, teamAlias, models }) => ({ teamId, teamAlias, models }));
    return { userId, email: user.email, teams };
  }

  async createUser({ userId, email }: { userId: string; email: string }): Promise<void> {
    // Comme une contrainte d'unicité : recréer un utilisateur existant est une erreur.
    if (this.users.has(userId)) throw new Error(`utilisateur déjà existant : ${userId}`);
    this.users.set(userId, { email });
  }

  async addTeamMember(teamId: string, userId: string): Promise<void> {
    const team = this.teams.get(teamId);
    if (!team) throw new Error(`équipe inconnue : ${teamId}`);
    if (!team.memberUids.includes(userId)) team.memberUids.push(userId);
  }

  async getTeam(teamId: string): Promise<LiteLLMTeam | null> {
    const team = this.teams.get(teamId);
    return team ? { ...team, models: [...team.models], memberUids: [...team.memberUids] } : null;
  }

  async listModels(): Promise<LiteLLMModel[]> {
    return this.models.map((m) => ({ ...m }));
  }

  async listTeams() {
    return [...this.teams.values()].map(({ teamId, teamAlias, models }) => ({ teamId, teamAlias, models }));
  }

  // --- préparation des scénarios ---

  withTeam(team: { teamId: string; teamAlias?: string; models: string[]; memberUids: string[] }): this {
    this.teams.set(team.teamId, { teamAlias: team.teamId, ...team });
    return this;
  }

  withModel(model: Partial<LiteLLMModel> & { modelName: string }): this {
    this.models.push({
      modelId: `id-${model.modelName}`,
      supplier: "OpenRouter",
      publisher: null,
      capabilities: [],
      hosts: [],
      executionRegion: "UE",
      apiKind: "conversation",
      inputCostPerToken: 0.0000004,
      outputCostPerToken: 0.0000027,
      pricingCurrency: "EUR",
      dataLevel: null,
      hosting: null,
      maxInputTokens: 128000,
      ...model,
    });
    return this;
  }
}
