-- Vues de reporting pour Superset (schéma "reporting" de la base litellm).
-- Montants (spend) exprimés en EUR : chaque modèle porte un tarif EUR explicite (model_info.pricing_currency = 'EUR').
-- À exécuter EN TANT QUE rôle litellm, APRÈS le premier démarrage de LiteLLM (tables créées) :
--   docker compose exec -T postgres psql -U litellm -d litellm -v ON_ERROR_STOP=1 -f - < postgres/reporting_views.sql
-- Idempotent (CREATE OR REPLACE). Le rôle reporting_ro ne lit QUE ces vues.
-- Colonnes vérifiées sur schema.prisma de LiteLLM (sept. 2026) : à revérifier à chaque montée de version.

-- Clés actives + supprimées (pour ne pas perdre l'attribution des anciennes requêtes)
CREATE OR REPLACE VIEW reporting.v_keys AS
SELECT token AS key_hash, key_alias, user_id, team_id, models, max_budget, spend,
       expires, blocked, created_at,
       metadata->>'data_level'  AS data_level,
       metadata->>'project'     AS project,
       metadata->>'request_id'  AS portal_request_id,
       metadata->>'key_type'    AS key_type,
       false AS deleted
FROM "LiteLLM_VerificationToken"
UNION ALL
SELECT DISTINCT ON (token) token, key_alias, user_id, team_id, models, max_budget, spend,
       expires, blocked, created_at,
       metadata->>'data_level', metadata->>'project', metadata->>'request_id', metadata->>'key_type',
       true
FROM "LiteLLM_DeletedVerificationToken"
WHERE token NOT IN (SELECT token FROM "LiteLLM_VerificationToken");

CREATE OR REPLACE VIEW reporting.v_teams AS
SELECT team_id, team_alias, models, max_budget, spend, budget_duration, blocked, created_at
FROM "LiteLLM_TeamTable";

CREATE OR REPLACE VIEW reporting.v_users AS
SELECT user_id, user_email, user_alias, user_role, teams, spend, created_at
FROM "LiteLLM_UserTable";

CREATE OR REPLACE VIEW reporting.v_models AS
SELECT model_id, model_name,
       litellm_params->>'model'          AS provider_model,
       model_info->>'data_level'         AS data_level,
       model_info->>'hosting'            AS hosting,
       (model_info->>'input_cost_per_token')::numeric  AS input_cost_per_token,
       (model_info->>'output_cost_per_token')::numeric AS output_cost_per_token,
       model_info->>'pricing_currency'   AS pricing_currency,
       (model_info->>'fx_rate_usd_eur')::numeric AS fx_rate_usd_eur,
       blocked
FROM "LiteLLM_ProxyModelTable";

-- Détail par requête (rétention 90 j côté LiteLLM)
CREATE OR REPLACE VIEW reporting.v_requests AS
SELECT s.request_id,
       s."startTime"                         AS started_at,
       date_trunc('day', s."startTime")      AS day,
       s.call_type,
       s.status,
       s."user"                              AS user_id,
       u.user_email,
       s.team_id,
       t.team_alias,
       k.key_alias,
       k.key_type,
       k.project,
       k.data_level                          AS key_data_level,
       s.model_group                         AS model_name,
       s.model                               AS provider_model,
       s.custom_llm_provider                 AS provider,
       m.data_level                          AS model_data_level,
       m.pricing_currency,
       s.prompt_tokens, s.completion_tokens, s.total_tokens,
       s.spend,
       s.request_duration_ms
FROM "LiteLLM_SpendLogs" s
LEFT JOIN reporting.v_keys   k ON k.key_hash = s.api_key
LEFT JOIN reporting.v_teams  t ON t.team_id  = s.team_id
LEFT JOIN reporting.v_users  u ON u.user_id  = s."user"
LEFT JOIN reporting.v_models m ON m.model_id = s.model_id;

-- Agrégats journaliers (historique long, non purgé)
CREATE OR REPLACE VIEW reporting.v_daily_user AS
SELECT d.date::date AS day, d.user_id, u.user_email, k.key_alias, k.team_id, t.team_alias,
       k.project, k.data_level AS key_data_level,
       d.model_group AS model_name, d.custom_llm_provider AS provider,
       d.prompt_tokens, d.completion_tokens, d.spend,
       d.api_requests, d.successful_requests, d.failed_requests
FROM "LiteLLM_DailyUserSpend" d
LEFT JOIN reporting.v_keys  k ON k.key_hash = d.api_key
LEFT JOIN reporting.v_teams t ON t.team_id  = k.team_id
LEFT JOIN reporting.v_users u ON u.user_id  = d.user_id;

CREATE OR REPLACE VIEW reporting.v_daily_team AS
SELECT d.date::date AS day, d.team_id, t.team_alias,
       d.model_group AS model_name, d.custom_llm_provider AS provider,
       d.prompt_tokens, d.completion_tokens, d.spend,
       d.api_requests, d.successful_requests, d.failed_requests
FROM "LiteLLM_DailyTeamSpend" d
LEFT JOIN reporting.v_teams t ON t.team_id = d.team_id;

-- Contrôle devise : requêtes sur des modèles sans tarif EUR explicite (doit rester vide)
CREATE OR REPLACE VIEW reporting.v_check_pricing_eur AS
SELECT day, model_name, provider, count(*) AS requests, sum(spend) AS spend_unreliable
FROM reporting.v_requests
WHERE pricing_currency IS DISTINCT FROM 'EUR'
GROUP BY day, model_name, provider;

GRANT SELECT ON ALL TABLES IN SCHEMA reporting TO reporting_ro;
