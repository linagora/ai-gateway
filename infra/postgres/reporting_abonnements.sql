-- Abonnements dans le reporting (spécification #51, ticket #60, ADR 0002) : les vues du portail (schéma reporting de la
-- base portal), lues au travers du lien entre bases « portail » (postgres_fdw), et jointes à la dépense de la passerelle.
-- Les tables étrangères vont dans le schéma "portail", que reporting_ro ne lit pas : Superset ne voit que les vues du
-- schéma "reporting".
-- À exécuter EN TANT QUE rôle litellm, après reporting_views.sql, une fois le lien créé ; scripts/installer-lien-portail.sh
-- s'en charge. Idempotent : les tables étrangères sont réimportées (pour suivre les colonnes des vues du portail) et les
-- vues recréées, dans une même transaction.
-- Montants : la dépense de la passerelle est hors taxes (tarifs des fournisseurs), les abonnements toutes taxes comprises.

BEGIN;

CREATE SCHEMA IF NOT EXISTS portail;
DROP FOREIGN TABLE IF EXISTS portail.v_subscriptions, portail.v_subscription_charges CASCADE;
IMPORT FOREIGN SCHEMA reporting LIMIT TO (v_subscriptions, v_subscription_charges) FROM SERVER portail INTO portail;

-- Libellés des statuts d'abonnement, pour les tableaux de bord
CREATE OR REPLACE FUNCTION reporting.libelle_statut_abonnement(statut text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE statut WHEN 'ACTIF' THEN 'Actif' WHEN 'A_RESILIER' THEN 'À résilier' WHEN 'RESILIE' THEN 'Résilié' ELSE statut END
$$;

-- Abonnements par salarié : offre, équipe (nom actuel dans la passerelle), montant, dates, statut, adresse hors LINAGORA
-- (nominatif : admins uniquement)
CREATE OR REPLACE VIEW reporting.v_subscriptions AS
SELECT s.user_id, s.user_email,
       COALESCE(t.team_alias, s.team_alias, s.team_id)       AS team,
       s.supplier, s.offer,
       s.supplier || ' · ' || s.offer                        AS offer_label,
       s.monthly_amount_eur, s.subscribed_on, s.expires_on, s.terminated_on,
       reporting.libelle_statut_abonnement(s.status)         AS status,
       CASE WHEN s.account_outside_linagora THEN 'Oui' ELSE 'Non' END AS account_outside_linagora
FROM portail.v_subscriptions s
LEFT JOIN reporting.v_teams t ON t.team_id = s.team_id;

-- Abonnements en cours (actifs ou à résilier) par équipe, fournisseur et offre : nombre et coût mensuel TTC
-- (agrégé, sans donnée par personne : ouvert aux lecteurs du reporting)
CREATE OR REPLACE VIEW reporting.v_team_subscriptions AS
SELECT COALESCE(t.team_alias, s.team_alias, s.team_id) AS team,
       s.supplier, s.offer,
       count(*)::bigint                                AS active_subscriptions,
       sum(s.monthly_amount_eur)                       AS monthly_cost_ttc
FROM portail.v_subscriptions s
LEFT JOIN reporting.v_teams t ON t.team_id = s.team_id
WHERE s.status <> 'RESILIE'
GROUP BY 1, 2, 3;

-- Coût mensuel par équipe : dépense de la passerelle (HT), prélèvements des abonnements (TTC) et leur total, mois au
-- premier jour (agrégé : ouvert aux lecteurs du reporting)
CREATE OR REPLACE VIEW reporting.v_team_monthly_cost AS
WITH passerelle AS (
  SELECT date_trunc('month', d.date::date)::date AS month, NULLIF(d.team_id, '') AS team_id, sum(d.spend) AS cost
  FROM "LiteLLM_DailyTeamSpend" d
  GROUP BY 1, 2
), abonnements AS (
  SELECT date_trunc('month', c.charged_on)::date AS month, c.team_id, max(c.team_alias) AS team_alias, sum(c.amount_eur) AS cost
  FROM portail.v_subscription_charges c
  GROUP BY 1, 2
)
SELECT COALESCE(p.month, a.month)                                                  AS month,
       COALESCE(t.team_alias, a.team_alias, p.team_id, a.team_id, '(sans équipe)') AS team,
       COALESCE(p.cost, 0)                                                         AS gateway_cost_ht,
       COALESCE(a.cost, 0)                                                         AS subscriptions_cost_ttc,
       COALESCE(p.cost, 0) + COALESCE(a.cost, 0)                                   AS total_cost
FROM passerelle p
FULL JOIN abonnements a ON a.month = p.month AND a.team_id = p.team_id
LEFT JOIN reporting.v_teams t ON t.team_id = COALESCE(p.team_id, a.team_id);

-- Coût mensuel par salarié : dépense de la passerelle (HT), prélèvements de ses abonnements (TTC) et leur total
-- (nominatif : admins uniquement)
CREATE OR REPLACE VIEW reporting.v_user_monthly_cost AS
WITH passerelle AS (
  SELECT date_trunc('month', d.date::date)::date AS month, d.user_id, sum(d.spend) AS cost
  FROM "LiteLLM_DailyUserSpend" d
  GROUP BY 1, 2
), abonnements AS (
  SELECT date_trunc('month', c.charged_on)::date AS month, c.user_id, sum(c.amount_eur) AS cost
  FROM portail.v_subscription_charges c
  GROUP BY 1, 2
)
SELECT COALESCE(p.month, a.month)                 AS month,
       COALESCE(p.user_id, a.user_id)             AS user_id,
       COALESCE(p.cost, 0)                        AS gateway_cost_ht,
       COALESCE(a.cost, 0)                        AS subscriptions_cost_ttc,
       COALESCE(p.cost, 0) + COALESCE(a.cost, 0)  AS total_cost
FROM passerelle p
FULL JOIN abonnements a ON a.month = p.month AND a.user_id = p.user_id;

GRANT SELECT ON ALL TABLES IN SCHEMA reporting TO reporting_ro;

COMMIT;
