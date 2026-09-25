-- Vues de reporting pour Superset (schéma "reporting" de la base litellm).
-- Montants (spend) exprimés en EUR : chaque modèle porte un tarif EUR explicite (model_info.pricing_currency = 'EUR').
-- À exécuter EN TANT QUE rôle litellm, APRÈS le premier démarrage de LiteLLM (tables créées) :
--   docker compose exec -T postgres psql -U litellm -d litellm -v ON_ERROR_STOP=1 -f - < postgres/reporting_views.sql
-- Idempotent (CREATE OR REPLACE). Le rôle reporting_ro ne lit QUE ces vues.
-- Colonnes vérifiées sur schema.prisma de LiteLLM (sept. 2026) : à revérifier à chaque montée de version.

-- Libellés des niveaux de sensibilité (PRD §5), pour les tableaux de bord
CREATE OR REPLACE FUNCTION reporting.libelle_niveau(niveau text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE niveau WHEN 'N1' THEN 'N1 — Public' WHEN 'N2' THEN 'N2 — Interne' WHEN 'N3' THEN 'N3 — Confidentiel'
                     WHEN 'EXP' THEN 'Expérimental (bêta)' ELSE 'Non renseigné' END
$$;

-- Libellés des hébergements (model_info.hosting)
CREATE OR REPLACE FUNCTION reporting.libelle_hebergement(hebergement text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE hebergement WHEN 'INTERNE' THEN 'Linagora' WHEN 'INTERNE_OVH' THEN 'OVHcloud' WHEN 'UE' THEN 'Union européenne'
                          WHEN 'HORS_UE' THEN 'Hors UE' ELSE 'Non renseigné' END
$$;

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
(SELECT DISTINCT ON (token) token, key_alias, user_id, team_id, models, max_budget, spend,
        expires, blocked, created_at,
        metadata->>'data_level', metadata->>'project', metadata->>'request_id', metadata->>'key_type',
        true
 FROM "LiteLLM_DeletedVerificationToken"
 WHERE token NOT IN (SELECT token FROM "LiteLLM_VerificationToken")
 ORDER BY token, deleted_at DESC);

-- Équipes actives + supprimées (même raison que v_keys)
CREATE OR REPLACE VIEW reporting.v_teams AS
SELECT team_id, team_alias, models, max_budget, spend, budget_duration, blocked, created_at,
       false AS deleted
FROM "LiteLLM_TeamTable"
UNION ALL
(SELECT DISTINCT ON (team_id) team_id, team_alias, models, max_budget, spend, budget_duration, blocked, created_at,
        true
 FROM "LiteLLM_DeletedTeamTable"
 WHERE team_id NOT IN (SELECT team_id FROM "LiteLLM_TeamTable")
 ORDER BY team_id, deleted_at DESC);

CREATE OR REPLACE VIEW reporting.v_users AS
SELECT user_id, user_email, user_alias, user_role, teams, spend, created_at
FROM "LiteLLM_UserTable";

-- Prix : dans litellm_params (LiteLLM ≥ 1.10x supprime ceux placés dans model_info). Dans
-- litellm_params, les nombres sont stockés en clair mais les chaînes (modèle fournisseur, URL,
-- clé) sont chiffrées : le modèle fournisseur réel se lit dans v_requests (LiteLLM_SpendLogs).
-- Conversion défensive : une valeur non numérique donne NULL au lieu de casser toutes les vues.
CREATE OR REPLACE VIEW reporting.v_models AS
SELECT model_id, model_name,
       model_info->>'data_level'         AS data_level,
       model_info->>'hosting'            AS hosting,
       CASE WHEN litellm_params->>'input_cost_per_token' ~ '^[0-9.eE+-]+$'
            THEN (litellm_params->>'input_cost_per_token')::numeric END  AS input_cost_per_token,
       CASE WHEN litellm_params->>'output_cost_per_token' ~ '^[0-9.eE+-]+$'
            THEN (litellm_params->>'output_cost_per_token')::numeric END AS output_cost_per_token,
       model_info->>'pricing_currency'   AS pricing_currency,
       CASE WHEN model_info->>'fx_rate_usd_eur' ~ '^[0-9.eE+-]+$'
            THEN (model_info->>'fx_rate_usd_eur')::numeric END AS fx_rate_usd_eur,
       blocked,
       -- Fournisseur affiché : LiteLLM attribue à « openai » tout modèle joint en openai/…
       -- (OpenRouter, OVHcloud) ; la passerelle déclare le vrai fournisseur dans model_info.
       model_info->>'fournisseur'        AS fournisseur,
       model_info->>'zone'               AS zone
FROM "LiteLLM_ProxyModelTable";

-- Un modèle par nom exposé (un nom peut avoir plusieurs déploiements)
CREATE OR REPLACE VIEW reporting.v_model_names AS
SELECT DISTINCT ON (model_name) model_name, fournisseur, data_level, hosting, zone
FROM reporting.v_models
ORDER BY model_name, model_id;

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
       NULLIF(s.model_group, '')             AS model_name,   -- '' pour les appels sans modèle
       s.model                               AS provider_model,
       COALESCE(m.fournisseur, NULLIF(s.custom_llm_provider, '')) AS provider,
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
       NULLIF(d.model_group, '') AS model_name, COALESCE(m.fournisseur, NULLIF(d.custom_llm_provider, '')) AS provider,
       d.prompt_tokens, d.completion_tokens, d.spend,
       d.api_requests, d.successful_requests, d.failed_requests
FROM "LiteLLM_DailyUserSpend" d
LEFT JOIN reporting.v_keys  k ON k.key_hash = d.api_key
LEFT JOIN reporting.v_teams t ON t.team_id  = k.team_id
LEFT JOIN reporting.v_users u ON u.user_id  = d.user_id
LEFT JOIN reporting.v_model_names m ON m.model_name = NULLIF(d.model_group, '');

CREATE OR REPLACE VIEW reporting.v_daily_team AS
SELECT d.date::date AS day, d.team_id, t.team_alias,
       NULLIF(d.model_group, '') AS model_name, COALESCE(m.fournisseur, NULLIF(d.custom_llm_provider, '')) AS provider,
       d.prompt_tokens, d.completion_tokens, d.spend,
       d.api_requests, d.successful_requests, d.failed_requests
FROM "LiteLLM_DailyTeamSpend" d
LEFT JOIN reporting.v_teams t ON t.team_id = d.team_id
LEFT JOIN reporting.v_model_names m ON m.model_name = NULLIF(d.model_group, '');

-- Contrôle devise : requêtes sur des modèles sans tarif EUR explicite (doit rester vide).
-- Les requêtes sans modèle (ex. /v1/models refusé à une clé révoquée) ne sont pas concernées.
CREATE OR REPLACE VIEW reporting.v_check_pricing_eur AS
SELECT day, model_name, provider, count(*) AS requests, sum(spend) AS spend_unreliable
FROM reporting.v_requests
WHERE pricing_currency IS DISTINCT FROM 'EUR' AND model_name IS NOT NULL
GROUP BY day, model_name, provider;

-- ---------------------------------------------------------------------------------------------
-- Tableaux de bord. Les lecteurs du reporting (rôle Superset « Lecteur reporting ») ne voient que
-- les trois vues suivantes, sans donnée par personne ni par clé ; les autres vues sont réservées
-- aux admins (superset/init-reporting.py).

-- Consommation journalière par équipe, modèle, fournisseur, niveau déclaré de la clé et hébergement
CREATE OR REPLACE VIEW reporting.v_usage_daily AS
SELECT d.date::date AS day,
       COALESCE(t.team_alias, NULLIF(d.team_id, ''), '(sans équipe)')           AS team,
       COALESCE(NULLIF(d.model_group, ''), '(aucun modèle)')                    AS model_name,
       COALESCE(m.fournisseur, NULLIF(d.custom_llm_provider, ''), '(inconnu)')  AS provider,
       reporting.libelle_niveau(k.data_level)                                   AS key_level,
       reporting.libelle_hebergement(m.hosting)                                 AS hosting,
       sum(d.prompt_tokens)::bigint                       AS prompt_tokens,
       sum(d.completion_tokens)::bigint                   AS completion_tokens,
       sum(d.prompt_tokens + d.completion_tokens)::bigint AS total_tokens,
       sum(d.spend)                                       AS spend,
       sum(d.api_requests)::bigint                        AS requests,
       sum(d.successful_requests)::bigint                 AS successful_requests,
       sum(d.failed_requests)::bigint                     AS failed_requests
FROM "LiteLLM_DailyTeamSpend" d
LEFT JOIN reporting.v_keys        k ON k.key_hash   = d.api_key
LEFT JOIN reporting.v_teams       t ON t.team_id    = d.team_id
LEFT JOIN reporting.v_model_names m ON m.model_name = NULLIF(d.model_group, '')
GROUP BY 1, 2, 3, 4, 5, 6;

-- Budget des équipes : dépense de la période en cours rapportée au plafond
CREATE OR REPLACE VIEW reporting.v_team_budget AS
SELECT COALESCE(team_alias, team_id) AS team, max_budget, budget_duration, budget_reset_at, spend,
       CASE WHEN max_budget > 0 THEN spend / max_budget END AS budget_used
FROM "LiteLLM_TeamTable";

-- Nombre d'équipes et de clés ayant consommé sur 7, 30 et 90 jours (comptes seulement)
CREATE OR REPLACE VIEW reporting.v_activity AS
SELECT w.days AS window_days,
       count(DISTINCT NULLIF(d.team_id, '')) AS active_teams,
       count(DISTINCT d.api_key)             AS active_keys
FROM (VALUES (7), (30), (90)) AS w(days)
LEFT JOIN "LiteLLM_DailyTeamSpend" d ON d.date::date > current_date - w.days AND d.successful_requests > 0
GROUP BY w.days;

-- État des clés nommées : budget consommé, dernière utilisation (nominatif : admins uniquement)
CREATE OR REPLACE VIEW reporting.v_key_status AS
SELECT k.key_alias, k.user_id, u.user_email,
       COALESCE(t.team_alias, k.team_id, '(sans équipe)')  AS team,
       reporting.libelle_niveau(k.metadata->>'data_level') AS key_level,
       k.max_budget, k.budget_duration, k.budget_reset_at, k.spend,
       CASE WHEN k.max_budget > 0 THEN k.spend / k.max_budget END AS budget_used,
       k.expires, k.created_at, a.last_used,
       current_date - COALESCE(a.last_used, k.created_at::date) AS days_inactive,
       CASE WHEN k.blocked IS TRUE THEN 'Bloquée' WHEN k.expires < now() THEN 'Expirée' ELSE 'Active' END AS status
FROM "LiteLLM_VerificationToken" k
LEFT JOIN (SELECT api_key, max(date::date) AS last_used FROM "LiteLLM_DailyTeamSpend"
           WHERE api_requests > 0 GROUP BY api_key) a ON a.api_key = k.token
LEFT JOIN "LiteLLM_TeamTable" t ON t.team_id = k.team_id
LEFT JOIN "LiteLLM_UserTable" u ON u.user_id = k.user_id
WHERE k.key_alias IS NOT NULL;

GRANT SELECT ON ALL TABLES IN SCHEMA reporting TO reporting_ro;
