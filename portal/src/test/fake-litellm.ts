import { randomBytes } from "node:crypto";
import type { GeneratedKey, KeyInfo, KeyParams, LiteLLMClient, LiteLLMModel, LiteLLMTeam, LiteLLMUser } from "@/lib/litellm/client";

/** Clé connue du LiteLLM simulé ; `key` n'y est gardée que pour les vérifications des tests. */
export interface FakeKey extends KeyParams {
  key: string;
  tokenId: string;
  expiresAt: Date;
  spend: number;
  budgetResetAt: Date;
  blocked: boolean;
}

/** Durée LiteLLM (30d, 12h, 90m, 3600s) en millisecondes. */
function durationMs(duration: string): number {
  const match = /^(\d+)([smhd])$/.exec(duration);
  if (!match) throw new Error(`durée invalide : ${duration}`);
  return Number(match[1]) * { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as "s" | "m" | "h" | "d"];
}

/**
 * LiteLLM simulé en mémoire pour tester les cas d'usage (frontière avec un système externe).
 * Se comporte comme le vrai sur les points vérifiés par les tests de contrat (client.int.test.ts).
 */
export class FakeLiteLLM implements LiteLLMClient {
  readonly users = new Map<string, { email: string }>();
  readonly teams = new Map<string, LiteLLMTeam>();
  models: LiteLLMModel[] = [];
  readonly keys = new Map<string, FakeKey>();
  /** Horloge des expirations, alignée par les tests sur la date du jour qu'ils injectent. */
  horloge: () => Date = () => new Date();
  /** Simule une passerelle injoignable pour les opérations sur les clés. */
  panne = false;

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

  async generateKey(params: KeyParams): Promise<GeneratedKey> {
    if (this.panne) throw new Error("LiteLLM injoignable");
    // Comme LiteLLM 1.102.1 : un alias déjà pris est refusé.
    if ([...this.keys.values()].some((k) => k.alias === params.alias)) throw new Error(`Key with alias '${params.alias}' already exists.`);
    const key = `sk-${randomBytes(12).toString("hex")}`;
    const tokenId = randomBytes(32).toString("hex");
    const maintenant = this.horloge().getTime();
    const expiresAt = new Date(maintenant + durationMs(params.duration));
    const budgetResetAt = new Date(maintenant + durationMs(params.budgetDuration));
    this.keys.set(tokenId, { ...params, key, tokenId, expiresAt, spend: 0, budgetResetAt, blocked: false });
    return { key, tokenId, alias: params.alias, expiresAt };
  }

  async getKeyInfo(tokenId: string): Promise<KeyInfo | null> {
    if (this.panne) throw new Error("LiteLLM injoignable");
    const k = this.keys.get(tokenId);
    return k ? { spend: k.spend, maxBudget: k.maxBudget, budgetResetAt: k.budgetResetAt, expiresAt: k.expiresAt, blocked: k.blocked } : null;
  }

  async deleteKey(tokenId: string): Promise<void> {
    if (this.panne) throw new Error("LiteLLM injoignable");
    if (!this.keys.delete(tokenId)) throw new Error("clé inconnue");
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
