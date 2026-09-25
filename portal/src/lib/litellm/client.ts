import "server-only";
import { z } from "zod";

/**
 * Client typé de l'API d'administration LiteLLM (brief §3). SERVEUR UNIQUEMENT : il porte la clé
 * maître. Chaque réponse est validée par un schéma : un changement d'API casse ici, pas plus loin.
 */

export interface LiteLLMConfig {
  /** Base de l'API, préfixe /admin compris (ex. http://litellm:4000/admin). */
  baseUrl: string;
  masterKey: string;
}

export class LiteLLMError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "LiteLLMError";
  }
}

export interface LiteLLMTeamSummary {
  teamId: string;
  teamAlias: string;
  models: string[];
}

export interface LiteLLMUser {
  userId: string;
  email: string | null;
  teams: LiteLLMTeamSummary[];
}

export interface LiteLLMTeam extends LiteLLMTeamSummary {
  memberUids: string[];
}

/** Capacité d'un modèle, déclarée par la passerelle (les outils et le JSON, communs à tous, n'en sont pas). */
export type Capability = "images" | "audio_video" | "raisonnement";

export const CAPABILITIES: readonly Capability[] = ["images", "audio_video", "raisonnement"];

/** Zone d'exécution d'un modèle (glossaire) : UE ou hors UE. */
export type ExecutionRegion = "UE" | "HORS_UE";

/**
 * Manière d'appeler un modèle : conversation (par défaut), ou API de décision comme JEV (« System One »),
 * qui attend dans le dernier message une requête JSON et non un texte libre.
 */
export type ApiKind = "conversation" | "decision";

/**
 * Modèle déclaré dans LiteLLM. Les prix, déclarés dans litellm_params, sont relus via model_info.
 * Fournisseur, éditeur, capacités, hébergeurs, zone et type d'API sont déclarés par la passerelle dans model_info.
 */
export interface LiteLLMModel {
  modelId: string;
  modelName: string;
  supplier: string | null;
  publisher: string | null;
  capabilities: Capability[];
  hosts: string[];
  executionRegion: ExecutionRegion | null;
  apiKind: ApiKind;
  inputCostPerToken: number | null;
  outputCostPerToken: number | null;
  pricingCurrency: string | null;
  dataLevel: string | null;
  hosting: string | null;
  maxInputTokens: number | null;
}

export interface LiteLLMClient {
  getUser(userId: string): Promise<LiteLLMUser | null>;
  /** F-02 : crée l'utilisateur (rôle internal_user) SANS clé : aucune clé hors du circuit de validation. */
  createUser(input: { userId: string; email: string }): Promise<void>;
  /** F-22 : ajoute l'utilisateur à l'équipe avec le rôle « user ». */
  addTeamMember(teamId: string, userId: string): Promise<void>;
  /** Équipe avec ses modèles et ses membres (règle 3) ; null si elle n'existe pas. */
  getTeam(teamId: string): Promise<LiteLLMTeam | null>;
  /** F-10 : modèles déclarés dans LiteLLM (GET /model/info). */
  listModels(): Promise<LiteLLMModel[]>;
  /** F-22 : équipes existantes, pour les demandes d'adhésion. */
  listTeams(): Promise<LiteLLMTeamSummary[]>;
}

const teamSummarySchema = z.object({
  team_id: z.string(),
  team_alias: z.string().nullish(),
  models: z.array(z.string()).nullish(),
});

const userInfoSchema = z.object({
  user_id: z.string(),
  user_info: z.object({ user_email: z.string().nullish() }).nullish(),
  teams: z.array(teamSummarySchema).nullish(),
});

const teamInfoSchema = z.object({
  team_id: z.string(),
  team_info: z.object({
    team_alias: z.string().nullish(),
    models: z.array(z.string()).nullish(),
    members_with_roles: z.array(z.object({ user_id: z.string().nullish() })).nullish(),
  }),
});

const modelInfoSchema = z.object({
  data: z.array(
    z.object({
      model_name: z.string(),
      model_info: z.object({
        id: z.string(),
        /** Déclarés par la passerelle : la route de LiteLLM (openai/…) ne dit rien du vrai fournisseur. */
        fournisseur: z.string().nullish(),
        editeur: z.string().nullish(),
        capacites: z.array(z.string()).nullish(),
        hebergeurs: z.array(z.string()).nullish(),
        zone: z.string().nullish(),
        type_api: z.string().nullish(),
        input_cost_per_token: z.number().nullish(),
        output_cost_per_token: z.number().nullish(),
        pricing_currency: z.string().nullish(),
        data_level: z.string().nullish(),
        hosting: z.string().nullish(),
        max_input_tokens: z.number().nullish(),
      }),
    }),
  ),
});

const errorSchema = z.object({ error: z.object({ message: z.string() }) });

export function createLiteLLMClient(config: LiteLLMConfig): LiteLLMClient {
  async function call(method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<{ status: number; data: unknown }> {
    const response = await fetch(`${config.baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${config.masterKey}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
    });
    const text = await response.text();
    const data: unknown = text ? JSON.parse(text) : null;
    return { status: response.status, data };
  }

  function fail(method: string, path: string, status: number, data: unknown): never {
    const parsed = errorSchema.safeParse(data);
    const detail = parsed.success ? parsed.data.error.message : `réponse inattendue`;
    // Chemin sans paramètres : ni identifiant ni secret dans les messages d'erreur.
    throw new LiteLLMError(status, `LiteLLM ${method} ${path.split("?")[0]} : HTTP ${status} — ${detail}`);
  }

  return {
    async getUser(userId) {
      const path = `/user/info?user_id=${encodeURIComponent(userId)}`;
      const { status, data } = await call("GET", path);
      if (status === 404) return null;
      if (status !== 200) fail("GET", path, status, data);
      const info = userInfoSchema.parse(data);
      return {
        userId: info.user_id,
        email: info.user_info?.user_email ?? null,
        teams: (info.teams ?? []).map(toTeamSummary),
      };
    },

    async createUser({ userId, email }) {
      // auto_create_key vaut true par défaut dans LiteLLM 1.102 : sans ce drapeau, chaque premier
      // passage sur le portail créerait une clé non validée.
      const body = { user_id: userId, user_email: email, user_role: "internal_user", auto_create_key: false };
      const { status, data } = await call("POST", "/user/new", body);
      if (status !== 200) fail("POST", "/user/new", status, data);
    },

    async addTeamMember(teamId, userId) {
      const body = { team_id: teamId, member: { user_id: userId, role: "user" } };
      const { status, data } = await call("POST", "/team/member_add", body);
      if (status !== 200) fail("POST", "/team/member_add", status, data);
    },

    async getTeam(teamId) {
      const path = `/team/info?team_id=${encodeURIComponent(teamId)}`;
      const { status, data } = await call("GET", path);
      if (status === 404) return null;
      if (status !== 200) fail("GET", path, status, data);
      const { team_id, team_info } = teamInfoSchema.parse(data);
      return {
        teamId: team_id,
        teamAlias: team_info.team_alias ?? team_id,
        models: team_info.models ?? [],
        memberUids: (team_info.members_with_roles ?? []).flatMap((m) => (m.user_id ? [m.user_id] : [])),
      };
    },

    async listModels() {
      const { status, data } = await call("GET", "/model/info");
      if (status !== 200) fail("GET", "/model/info", status, data);
      return modelInfoSchema.parse(data).data.map(({ model_name, model_info: mi }) => ({
        modelId: mi.id,
        modelName: model_name,
        supplier: mi.fournisseur ?? null,
        publisher: mi.editeur ?? null,
        capabilities: (mi.capacites ?? []).filter((c): c is Capability => CAPABILITIES.includes(c as Capability)),
        hosts: mi.hebergeurs ?? [],
        executionRegion: mi.zone === "UE" ? "UE" : mi.zone === "monde" ? "HORS_UE" : null,
        apiKind: mi.type_api === "decision" ? "decision" : "conversation",
        inputCostPerToken: mi.input_cost_per_token ?? null,
        outputCostPerToken: mi.output_cost_per_token ?? null,
        pricingCurrency: mi.pricing_currency ?? null,
        dataLevel: mi.data_level ?? null,
        hosting: mi.hosting ?? null,
        maxInputTokens: mi.max_input_tokens ?? null,
      }));
    },

    async listTeams() {
      const { status, data } = await call("GET", "/team/list");
      if (status !== 200) fail("GET", "/team/list", status, data);
      return z.array(teamSummarySchema).parse(data).map(toTeamSummary);
    },
  };
}

function toTeamSummary(t: z.infer<typeof teamSummarySchema>): LiteLLMTeamSummary {
  return { teamId: t.team_id, teamAlias: t.team_alias ?? t.team_id, models: t.models ?? [] };
}
