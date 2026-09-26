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

/**
 * Équipe avec ses membres réels (le membre technique que LiteLLM ajoute à chaque équipe n'en fait pas partie, ADR 0001)
 * et son budget d'équipe : plafond et période (null : sans limite), dépense de la période et date de sa remise à zéro.
 */
export interface LiteLLMTeam extends LiteLLMTeamSummary {
  memberUids: string[];
  maxBudget: number | null;
  budgetDuration: string | null;
  spend: number;
  budgetResetAt: Date | null;
}

/** Changements d'une équipe : son nom, ou son budget (null : sans limite). */
export interface TeamChanges {
  alias?: string;
  maxBudget?: number | null;
  budgetDuration?: string | null;
}

/**
 * Membre que LiteLLM ajoute à chaque équipe créée avec la clé maîtresse, avec le rôle « admin » d'équipe (fonction
 * Enterprise, inutilisée) : ce n'est pas un salarié, et le portail l'ignore partout.
 */
const MEMBRE_TECHNIQUE = "default_user_id";

/**
 * Capacité d'un modèle, déclarée par la passerelle (les outils et le JSON, communs à tous, n'en sont pas) :
 * lecture d'images, génération d'images, audio et vidéo, raisonnement.
 */
export type Capability = "images" | "generation_images" | "audio_video" | "raisonnement";

export const CAPABILITIES: readonly Capability[] = ["images", "generation_images", "audio_video", "raisonnement"];

/** Zone d'exécution d'un modèle (glossaire) : UE ou hors UE. */
export type ExecutionRegion = "UE" | "HORS_UE";

/**
 * Manière d'appeler un modèle : conversation (par défaut), API de décision comme JEV (« System One »), qui
 * attend dans le dernier message une requête JSON et non un texte libre, ou modèle d'images, appelé comme un
 * modèle de conversation en demandant une image en sortie.
 */
export type ApiKind = "conversation" | "decision" | "image";

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
  /** Prix indicatif d'une image en euros, déclaré par la passerelle pour un modèle d'images ; null sinon. */
  imagePrice: number | null;
  inputCostPerToken: number | null;
  outputCostPerToken: number | null;
  pricingCurrency: string | null;
  dataLevel: string | null;
  hosting: string | null;
  maxInputTokens: number | null;
}

/** Paramètres d'une clé à générer (F-40), figés à l'approbation de la demande. Durées au format LiteLLM : 30d, 3600s… */
export interface KeyParams {
  userId: string;
  teamId: string;
  models: string[];
  maxBudget: number;
  budgetDuration: string;
  /** Durée de validité (90d, 3600s…) ; null pour une clé qui n'expire jamais. */
  duration: string | null;
  rpmLimit: number | null;
  tpmLimit: number | null;
  alias: string;
  metadata: Record<string, string | null>;
  /** Dépense de départ : un remplacement reprend celle de la clé remplacée. */
  spend?: number;
}

/** Clé générée : `key` n'est rendue qu'une fois et ne doit jamais être conservée ; `tokenId` est son empreinte. */
export interface GeneratedKey {
  key: string;
  tokenId: string;
  alias: string;
  /** null pour une clé qui n'expire jamais. */
  expiresAt: Date | null;
}

/** Informations d'une clé émise, lues dans LiteLLM : dépense et budget en euros (tarifs déclarés en EUR). */
export interface KeyInfo {
  spend: number;
  maxBudget: number | null;
  budgetResetAt: Date | null;
  expiresAt: Date | null;
  blocked: boolean;
}

export interface LiteLLMClient {
  getUser(userId: string): Promise<LiteLLMUser | null>;
  /** F-02 : crée l'utilisateur (rôle internal_user) SANS clé : aucune clé hors du circuit de validation. */
  createUser(input: { userId: string; email: string }): Promise<void>;
  /** F-22 : ajoute l'utilisateur à l'équipe avec le rôle « user ». */
  addTeamMember(teamId: string, userId: string): Promise<void>;
  /** F-53 : retire un membre d'une équipe (sortie d'une équipe). */
  removeTeamMember(teamId: string, userId: string): Promise<void>;
  /** Équipe avec ses modèles et ses membres (règle 3) ; null si elle n'existe pas. */
  getTeam(teamId: string): Promise<LiteLLMTeam | null>;
  /** F-10 : modèles déclarés dans LiteLLM (GET /model/info). */
  listModels(): Promise<LiteLLMModel[]>;
  /** F-22 et F-53 : équipes existantes, avec leurs membres réels. */
  listTeams(): Promise<LiteLLMTeam[]>;
  /** F-53 : crée une équipe sans liste de modèles (tous les modèles, le portail contrôlant les niveaux) ; rend son identifiant. */
  createTeam(alias: string): Promise<string>;
  /** F-53 : renomme une équipe, ou fixe son budget d'équipe (null : sans limite). */
  updateTeam(teamId: string, changes: TeamChanges): Promise<void>;
  /** F-53 : supprime une équipe ; LiteLLM supprime aussi ses clés. */
  deleteTeam(teamId: string): Promise<void>;
  /** F-40 : génère une clé ; l'alias doit être unique dans LiteLLM. */
  generateKey(params: KeyParams): Promise<GeneratedKey>;
  /** F-42 : informations d'une clé d'après son empreinte ; null si LiteLLM ne la connaît pas. */
  getKeyInfo(tokenId: string): Promise<KeyInfo | null>;
  /** F-43 : supprime une clé d'après son empreinte ; la passerelle la refuse ensuite. */
  deleteKey(tokenId: string): Promise<void>;
  /** F-43 : bloque une clé (suspension temporaire et réversible). */
  blockKey(tokenId: string): Promise<void>;
  /** F-43 : débloque une clé bloquée. */
  unblockKey(tokenId: string): Promise<void>;
}

const teamSummarySchema = z.object({
  team_id: z.string(),
  team_alias: z.string().nullish(),
  models: z.array(z.string()).nullish(),
});

const membersSchema = z.array(z.object({ user_id: z.string().nullish() })).nullish();

/** Équipe telle que la liste LiteLLM (GET /team/list) : ses membres et son budget y figurent. */
const teamListItemSchema = teamSummarySchema.extend({
  members_with_roles: membersSchema,
  max_budget: z.number().nullish(),
  budget_duration: z.string().nullish(),
  spend: z.number().nullish(),
  budget_reset_at: z.string().nullish(),
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
    members_with_roles: membersSchema,
    max_budget: z.number().nullish(),
    budget_duration: z.string().nullish(),
    spend: z.number().nullish(),
    budget_reset_at: z.string().nullish(),
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
        prix_image_eur: z.number().nullish(),
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

const generatedKeySchema = z.object({
  key: z.string(),
  token_id: z.string().nullish(),
  token: z.string().nullish(),
  key_alias: z.string().nullish(),
  expires: z.string().nullish(),
});

const keyInfoSchema = z.object({
  info: z.object({
    spend: z.number().nullish(),
    max_budget: z.number().nullish(),
    budget_reset_at: z.string().nullish(),
    expires: z.string().nullish(),
    blocked: z.boolean().nullish(),
  }),
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
    throw new LiteLLMError(status, `LiteLLM ${method} ${path.split("?")[0]} : HTTP ${status} (${detail})`);
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

    async removeTeamMember(teamId, userId) {
      const { status, data } = await call("POST", "/team/member_delete", { team_id: teamId, user_id: userId });
      if (status !== 200) fail("POST", "/team/member_delete", status, data);
    },

    async getTeam(teamId) {
      const path = `/team/info?team_id=${encodeURIComponent(teamId)}`;
      const { status, data } = await call("GET", path);
      if (status === 404) return null;
      if (status !== 200) fail("GET", path, status, data);
      const { team_id, team_info } = teamInfoSchema.parse(data);
      return toTeam({ team_id, ...team_info });
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
        apiKind: mi.type_api === "decision" ? "decision" : mi.type_api === "image" ? "image" : "conversation",
        imagePrice: mi.prix_image_eur ?? null,
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
      return z.array(teamListItemSchema).parse(data).map(toTeam);
    },

    async createTeam(alias) {
      const { status, data } = await call("POST", "/team/new", { team_alias: alias });
      if (status !== 200) fail("POST", "/team/new", status, data);
      return z.object({ team_id: z.string() }).parse(data).team_id;
    },

    async deleteTeam(teamId) {
      const { status, data } = await call("POST", "/team/delete", { team_ids: [teamId] });
      if (status !== 200) fail("POST", "/team/delete", status, data);
    },

    async updateTeam(teamId, changes) {
      const body = {
        team_id: teamId,
        ...(changes.alias !== undefined ? { team_alias: changes.alias } : {}),
        ...(changes.maxBudget !== undefined ? { max_budget: changes.maxBudget } : {}),
        ...(changes.budgetDuration !== undefined ? { budget_duration: changes.budgetDuration } : {}),
      };
      const { status, data } = await call("POST", "/team/update", body);
      if (status !== 200) fail("POST", "/team/update", status, data);
    },

    async generateKey(params) {
      const body = {
        user_id: params.userId,
        team_id: params.teamId,
        models: params.models,
        max_budget: params.maxBudget,
        budget_duration: params.budgetDuration,
        ...(params.duration === null ? {} : { duration: params.duration }),
        key_alias: params.alias,
        metadata: params.metadata,
        ...(params.rpmLimit === null ? {} : { rpm_limit: params.rpmLimit }),
        ...(params.tpmLimit === null ? {} : { tpm_limit: params.tpmLimit }),
        ...(params.spend ? { spend: params.spend } : {}),
      };
      const { status, data } = await call("POST", "/key/generate", body);
      if (status !== 200) fail("POST", "/key/generate", status, data);
      const generated = generatedKeySchema.parse(data);
      const tokenId = generated.token_id ?? generated.token;
      if (!tokenId || (params.duration !== null && !generated.expires)) throw new LiteLLMError(status, "LiteLLM POST /key/generate : réponse incomplète");
      return { key: generated.key, tokenId, alias: generated.key_alias ?? params.alias, expiresAt: generated.expires ? new Date(generated.expires) : null };
    },

    async getKeyInfo(tokenId) {
      const path = `/key/info?key=${encodeURIComponent(tokenId)}`;
      const { status, data } = await call("GET", path);
      if (status === 404) return null;
      if (status !== 200) fail("GET", path, status, data);
      const { info } = keyInfoSchema.parse(data);
      return {
        spend: info.spend ?? 0,
        maxBudget: info.max_budget ?? null,
        budgetResetAt: info.budget_reset_at ? new Date(info.budget_reset_at) : null,
        expiresAt: info.expires ? new Date(info.expires) : null,
        blocked: info.blocked === true,
      };
    },

    async deleteKey(tokenId) {
      const { status, data } = await call("POST", "/key/delete", { keys: [tokenId] });
      if (status !== 200) fail("POST", "/key/delete", status, data);
    },

    async blockKey(tokenId) {
      const { status, data } = await call("POST", "/key/block", { key: tokenId });
      if (status !== 200) fail("POST", "/key/block", status, data);
    },

    async unblockKey(tokenId) {
      const { status, data } = await call("POST", "/key/unblock", { key: tokenId });
      if (status !== 200) fail("POST", "/key/unblock", status, data);
    },
  };
}

function toTeamSummary(t: z.infer<typeof teamSummarySchema>): LiteLLMTeamSummary {
  return { teamId: t.team_id, teamAlias: t.team_alias ?? t.team_id, models: t.models ?? [] };
}

/** Équipe avec ses membres réels, sans le membre technique. */
function toTeam(t: z.infer<typeof teamListItemSchema>): LiteLLMTeam {
  const memberUids = (t.members_with_roles ?? []).flatMap((m) => (m.user_id && m.user_id !== MEMBRE_TECHNIQUE ? [m.user_id] : []));
  return {
    ...toTeamSummary(t),
    memberUids,
    maxBudget: t.max_budget ?? null,
    budgetDuration: t.budget_duration ?? null,
    spend: t.spend ?? 0,
    budgetResetAt: t.budget_reset_at ? new Date(t.budget_reset_at) : null,
  };
}
