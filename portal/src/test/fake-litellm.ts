import { randomBytes } from "node:crypto";
import { type GeneratedKey, type KeyInfo, type KeyParams, type LiteLLMClient, LiteLLMError, type LiteLLMModel, type LiteLLMTeam, type LiteLLMUser, type ProbedApiKind, type ProbeResult, type TeamChanges } from "@/lib/litellm/client";

/** Clé connue du LiteLLM simulé ; `key` n'y est gardée que pour les vérifications des tests. */
export interface FakeKey extends KeyParams {
  key: string;
  tokenId: string;
  expiresAt: Date | null;
  spend: number;
  budgetResetAt: Date;
  blocked: boolean;
}

/** Équipe sans budget d'équipe : ni plafond, ni période, aucune dépense. */
const SANS_BUDGET = { maxBudget: null, budgetDuration: null, spend: 0, budgetResetAt: null };

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
  /** Empreintes des clés dont la suppression échoue. */
  readonly indestructibles = new Set<string>();
  /** Erreur rendue par la sonde de chaque modèle en panne ; les autres répondent. */
  readonly modelesEnPanne = new Map<string, string>();
  /** Modèles qui ne répondent pas dans le délai de la sonde. */
  readonly modelesSansReponse = new Set<string>();
  /** Sondes reçues, dans l'ordre : modèle et type d'API. */
  readonly sondes: { modelName: string; apiKind: ProbedApiKind }[] = [];

  async getUser(userId: string): Promise<LiteLLMUser | null> {
    const user = this.users.get(userId);
    if (!user) return null;
    const teams = [...this.teams.values()]
      .filter((t) => t.memberUids.includes(userId))
      .map(({ teamId, teamAlias, models }) => ({ teamId, teamAlias, models }));
    return { userId, email: user.email, teams };
  }

  async findUsersByEmail(email: string): Promise<{ userId: string; email: string }[]> {
    return [...this.users].filter(([, u]) => u.email.toLowerCase() === email.toLowerCase()).map(([userId, u]) => ({ userId, email: u.email }));
  }

  async createUser({ userId, email }: { userId: string; email: string }): Promise<void> {
    // Comme LiteLLM 1.102.1 : recréer un utilisateur existant est refusé (HTTP 409 « User with id … already exists »).
    if (this.users.has(userId)) throw new LiteLLMError(409, `LiteLLM POST /user/new : HTTP 409 (utilisateur déjà existant : ${userId})`);
    // Comme LiteLLM 1.102.1 : une adresse déjà prise par un autre utilisateur est refusée (HTTP 409).
    if ([...this.users.values()].some((u) => u.email === email)) throw new LiteLLMError(409, `LiteLLM POST /user/new : HTTP 409 (adresse déjà prise)`);
    this.users.set(userId, { email });
  }

  async addTeamMember(teamId: string, userId: string): Promise<void> {
    if (this.panne) throw new Error("LiteLLM injoignable");
    const team = this.teams.get(teamId);
    if (!team) throw new Error(`équipe inconnue : ${teamId}`);
    // Comme LiteLLM 1.102.1 : un membre déjà présent est refusé (HTTP 400 « User already in team »).
    if (team.memberUids.includes(userId)) throw new Error("User already in team.");
    team.memberUids.push(userId);
  }

  async removeTeamMember(teamId: string, userId: string): Promise<void> {
    if (this.panne) throw new Error("LiteLLM injoignable");
    const team = this.teams.get(teamId);
    if (!team) throw new Error(`équipe inconnue : ${teamId}`);
    team.memberUids = team.memberUids.filter((uid) => uid !== userId);
  }

  async getTeam(teamId: string): Promise<LiteLLMTeam | null> {
    const team = this.teams.get(teamId);
    return team ? { ...team, models: [...team.models], memberUids: [...team.memberUids] } : null;
  }

  async listModels(): Promise<LiteLLMModel[]> {
    return this.models.map((m) => ({ ...m }));
  }

  async listTeams(): Promise<LiteLLMTeam[]> {
    if (this.panne) throw new Error("LiteLLM injoignable");
    return [...this.teams.values()].map((t) => ({ ...t, models: [...t.models], memberUids: [...t.memberUids] }));
  }

  async createTeam(alias: string): Promise<string> {
    if (this.panne) throw new Error("LiteLLM injoignable");
    // Comme LiteLLM 1.102.1 : un nom déjà pris n'est pas refusé ; l'unicité est l'affaire du portail.
    const teamId = `equipe-${randomBytes(4).toString("hex")}`;
    this.teams.set(teamId, { teamId, teamAlias: alias, models: [], memberUids: [], ...SANS_BUDGET });
    return teamId;
  }

  async deleteTeam(teamId: string): Promise<void> {
    if (this.panne) throw new Error("LiteLLM injoignable");
    if (!this.teams.delete(teamId)) throw new Error(`équipe inconnue : ${teamId}`);
    // Comme LiteLLM 1.102.1 : les clés de l'équipe sont supprimées avec elle.
    for (const [tokenId, cle] of this.keys) if (cle.teamId === teamId) this.keys.delete(tokenId);
  }

  async countActiveTeamKeys(teamId: string): Promise<number> {
    if (this.panne) throw new Error("LiteLLM injoignable");
    const maintenant = this.horloge().getTime();
    return [...this.keys.values()].filter((k) => k.teamId === teamId && (k.expiresAt === null || k.expiresAt.getTime() > maintenant)).length;
  }

  async updateTeam(teamId: string, changes: TeamChanges): Promise<void> {
    if (this.panne) throw new Error("LiteLLM injoignable");
    const team = this.teams.get(teamId);
    if (!team) throw new Error(`équipe inconnue : ${teamId}`);
    if (changes.alias !== undefined) team.teamAlias = changes.alias;
    if (changes.maxBudget !== undefined) team.maxBudget = changes.maxBudget;
    if (changes.budgetDuration !== undefined) {
      team.budgetDuration = changes.budgetDuration;
      // Comme LiteLLM : une période fixe la prochaine remise à zéro ; sans période, il n'y en a pas.
      team.budgetResetAt = changes.budgetDuration ? new Date(this.horloge().getTime() + durationMs(changes.budgetDuration)) : null;
    }
  }

  async generateKey(params: KeyParams): Promise<GeneratedKey> {
    if (this.panne) throw new Error("LiteLLM injoignable");
    // Comme LiteLLM 1.102.1 : un alias déjà pris est refusé.
    if ([...this.keys.values()].some((k) => k.alias === params.alias)) throw new Error(`Key with alias '${params.alias}' already exists.`);
    const key = `sk-${randomBytes(12).toString("hex")}`;
    const tokenId = randomBytes(32).toString("hex");
    const maintenant = this.horloge().getTime();
    const expiresAt = params.duration === null ? null : new Date(maintenant + durationMs(params.duration));
    const budgetResetAt = new Date(maintenant + durationMs(params.budgetDuration));
    this.keys.set(tokenId, { ...params, key, tokenId, expiresAt, spend: params.spend ?? 0, budgetResetAt, blocked: false });
    return { key, tokenId, alias: params.alias, expiresAt };
  }

  async getKeyInfo(tokenId: string): Promise<KeyInfo | null> {
    if (this.panne) throw new Error("LiteLLM injoignable");
    const k = this.keys.get(tokenId);
    return k ? { spend: k.spend, maxBudget: k.maxBudget, budgetResetAt: k.budgetResetAt, expiresAt: k.expiresAt, blocked: k.blocked } : null;
  }

  async deleteKey(tokenId: string): Promise<void> {
    if (this.panne) throw new Error("LiteLLM injoignable");
    if (this.indestructibles.has(tokenId)) throw new Error("suppression impossible");
    if (!this.keys.delete(tokenId)) throw new Error("clé inconnue");
  }

  async blockKey(tokenId: string): Promise<void> {
    this.cleConnue(tokenId).blocked = true;
  }

  async unblockKey(tokenId: string): Promise<void> {
    this.cleConnue(tokenId).blocked = false;
  }

  async probeModel(modelName: string, apiKind: ProbedApiKind): Promise<ProbeResult> {
    this.sondes.push({ modelName, apiKind });
    if (this.panne) return { status: null, latencyMs: 0, error: "fetch failed", errorCode: "passerelle_injoignable" };
    if (this.modelesSansReponse.has(modelName)) return { status: null, latencyMs: 30_000, error: null, errorCode: "delai_depasse" };
    const erreur = this.modelesEnPanne.get(modelName);
    return erreur ? { status: 502, latencyMs: 40, error: erreur, errorCode: null } : { status: 200, latencyMs: 120, error: null, errorCode: null };
  }

  private cleConnue(tokenId: string): FakeKey {
    if (this.panne) throw new Error("LiteLLM injoignable");
    const k = this.keys.get(tokenId);
    if (!k) throw new Error("clé inconnue");
    return k;
  }

  // --- préparation des scénarios ---

  withTeam(team: { teamId: string; teamAlias?: string; models: string[]; memberUids: string[] } & Partial<Omit<LiteLLMTeam, "teamId">>): this {
    this.teams.set(team.teamId, { teamAlias: team.teamId, ...SANS_BUDGET, ...team });
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
      imagePrice: null,
      inputCostPerToken: 0.0000004,
      outputCostPerToken: 0.0000027,
      cacheReadCostPerToken: null,
      cacheWriteCostPerToken: null,
      inputCostPerTokenAbove200k: null,
      outputCostPerTokenAbove200k: null,
      fxRateUsdEur: null,
      pricingCurrency: "EUR",
      dataLevel: null,
      hosting: null,
      maxInputTokens: 128000,
      maxOutputTokens: null,
      reasoningEfforts: null,
      defaultReasoningEffort: null,
      inputContents: null,
      outputContents: null,
      dimensions: null,
      ...model,
    });
    return this;
  }
}
