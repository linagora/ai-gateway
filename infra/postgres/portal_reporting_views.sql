-- Vues de reporting des abonnements (spécification #51, ticket #60, ADR 0002), dans le schéma "reporting" de la base
-- portal. La base litellm les lit au travers d'un lien entre bases (postgres_fdw), avec le rôle portal_reporting_ro, qui
-- ne lit QUE ces vues. Codes bruts (statuts, niveaux) : les libellés sont posés côté litellm.
-- À exécuter EN TANT QUE rôle portal, après les migrations du portail ; scripts/installer-lien-portail.sh s'en charge.
-- Idempotent (CREATE OR REPLACE). Une migration du portail qui modifie une colonne lue ici échoue tant qu'une vue en
-- dépend : supprimer alors la vue (DROP VIEW reporting.<vue>), migrer, puis relancer installer-lien-portail.sh.

CREATE SCHEMA IF NOT EXISTS reporting;

-- Abonnements : titulaire, équipe, offre et fournisseur, montant mensuel TTC en vigueur, dates, statut, adresse du compte
-- chez le fournisseur et son signalement hors de LINAGORA.
CREATE OR REPLACE VIEW reporting.v_subscriptions AS
SELECT s.id                                                     AS subscription_id,
       s."holderUid"                                            AS user_id,
       s."holderEmail"                                          AS user_email,
       s."teamId"                                               AS team_id,
       s."teamAlias"                                            AS team_alias,
       o.supplier,
       o.name                                                   AS offer,
       s."monthlyAmountEur"::numeric(12, 2)                     AS monthly_amount_eur,
       s."subscribedAt"::date                                   AS subscribed_on,
       s."expiresAt"::date                                      AS expires_on,
       s."terminatedOn"::date                                   AS terminated_on,
       s.status::text                                           AS status,
       lower(btrim(s."accountEmail")) NOT LIKE '%@linagora.com' AS account_outside_linagora
FROM "Subscription" s
JOIN "SubscriptionOffer" o ON o.id = s."offerId";

-- Prélèvements : un par abonnement et par date anniversaire, avec le montant alors en vigueur et l'équipe imputée à
-- cette date, le titulaire et l'offre.
CREATE OR REPLACE VIEW reporting.v_subscription_charges AS
SELECT c.id                              AS charge_id,
       c."subscriptionId"                AS subscription_id,
       c."chargedOn"::date               AS charged_on,
       c."amountEur"::numeric(12, 2)     AS amount_eur,
       c."teamId"                        AS team_id,
       c."teamAlias"                     AS team_alias,
       s."holderUid"                     AS user_id,
       o.supplier,
       o.name                            AS offer
FROM "SubscriptionCharge" c
JOIN "Subscription" s ON s.id = c."subscriptionId"
JOIN "SubscriptionOffer" o ON o.id = s."offerId";

GRANT USAGE ON SCHEMA reporting TO portal_reporting_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA reporting TO portal_reporting_ro;
