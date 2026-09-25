-- Rappels d'expiration un mois, sept jours et la veille, selon la durée de la clé (ticket #27) :
-- délai annoncé par le dernier rappel envoyé, en jours.
ALTER TABLE "AccessRequest" ADD COLUMN "expiryReminderLead" INTEGER;
-- Les rappels déjà envoyés l'étaient sept jours avant l'expiration.
UPDATE "AccessRequest" SET "expiryReminderLead" = 7 WHERE "expiryReminderSentAt" IS NOT NULL;
