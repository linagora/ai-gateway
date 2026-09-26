-- Offres d'abonnement initiales (spécification #51) : les offres individuelles payantes d'Anthropic, d'OpenAI et de
-- Moonshot AI, relevées le 2026-09-26 sur les pages de tarifs des fournisseurs. DeepSeek n'en propose pas : il ne vend
-- que l'usage de son API, hors du périmètre des abonnements.
--
-- Prix mensuels TTC, en euros :
--   OpenAI : prix affichés en euros sur la page de tarifs française ;
--   Anthropic : estimés d'après le tarif européen officiel de Claude Pro (18 € HT), Max 5x et Max 20x au même rapport
--     (90 et 180 € HT), TVA de 20 % comprise ;
--   Moonshot AI : prix en dollars convertis au cours de référence de la BCE du 2026-09-25 (1 € = 1,1403 $), TVA de
--     20 % comprise.
-- Niveaux : N1 Public au plus chez Anthropic et OpenAI, entraînement désactivé ; données publiques seulement chez
-- Moonshot AI. Les admins tiennent ensuite ces offres dans la gestion du catalogue, et chaque titulaire déclare le
-- montant réellement prélevé. Chaque création est inscrite au journal d'audit, comme depuis la gestion.
WITH offres AS (
  INSERT INTO "SubscriptionOffer" ("id", "supplier", "name", "monthlyPriceEur", "dataLevel", "rulesFr", "rulesEn", "url", "updatedAt", "updatedBy")
  SELECT o.id, o.supplier, o.name, o.prix, o.niveau::"DataLevel", r.regles_fr, r.regles_en, r.url, CURRENT_TIMESTAMP, 'systeme'
  FROM (VALUES
    ('anthropic-claude-pro', 'Anthropic', 'Claude Pro', 21.60, 'N1'),
    ('anthropic-claude-max-5x', 'Anthropic', 'Claude Max 5x', 108.00, 'N1'),
    ('anthropic-claude-max-20x', 'Anthropic', 'Claude Max 20x', 216.00, 'N1'),
    ('openai-chatgpt-go', 'OpenAI', 'ChatGPT Go', 8.00, 'N1'),
    ('openai-chatgpt-plus', 'OpenAI', 'ChatGPT Plus', 23.00, 'N1'),
    ('openai-chatgpt-pro-5x', 'OpenAI', 'ChatGPT Pro 5x', 103.00, 'N1'),
    ('moonshot-kimi-plus', 'Moonshot AI', 'Kimi Plus', 19.99, 'EXP'),
    ('moonshot-kimi-pro', 'Moonshot AI', 'Kimi Pro', 41.04, 'EXP'),
    ('moonshot-kimi-max', 'Moonshot AI', 'Kimi Max', 104.18, 'EXP'),
    ('moonshot-kimi-ultra', 'Moonshot AI', 'Kimi Ultra', 209.42, 'EXP')
  ) AS o (id, supplier, name, prix, niveau)
  JOIN (VALUES
    (
      'Anthropic',
      E'Avant tout usage, désactivez « Aider à améliorer nos modèles d''IA » dans Paramètres, rubrique Confidentialité : vos conversations ne serviront pas à entraîner les modèles.',
      'Before any use, turn off “Help improve our AI models” in Settings, Privacy, so that your conversations are not used to train the models.',
      'https://claude.com/pricing'
    ),
    (
      'OpenAI',
      E'Avant tout usage, désactivez « Améliorer le modèle pour tous » dans Paramètres, rubrique Contrôles des données : ce réglage est activé par défaut.',
      'Before any use, turn off “Improve the model for everyone” in Settings, Data controls: this setting is on by default.',
      'https://chatgpt.com/fr-FR/pricing/'
    ),
    (
      'Moonshot AI',
      E'Données publiques uniquement : ni donnée interne, ni donnée client, ni donnée personnelle. Avant tout usage, désactivez « Improve the model for everyone » dans Settings, rubrique Security.',
      'Public data only: no internal, customer or personal data. Before any use, turn off “Improve the model for everyone” in Settings, Security.',
      'https://www.kimi.ai/membership/pricing'
    )
  ) AS r (supplier, regles_fr, regles_en, url) USING (supplier)
  RETURNING "id", "supplier", "name", "monthlyPriceEur", "dataLevel", "visible"
)
INSERT INTO "AuditLog" ("actorUid", "action", "targetId", "details")
SELECT 'systeme', 'OFFER_CREATED', "id",
  jsonb_build_object('fournisseur', "supplier", 'offre', "name", 'prix', "monthlyPriceEur"::float8, 'niveau', "dataLevel", 'visible', "visible")
FROM offres;
