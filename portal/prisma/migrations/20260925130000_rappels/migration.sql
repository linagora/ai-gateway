-- Rappels de la tâche quotidienne : J-3 avant l'échéance de retrait, J-7 avant l'expiration de la clé.
ALTER TABLE "AccessRequest" ADD COLUMN "pickupReminderSentAt" TIMESTAMP(3);
ALTER TABLE "AccessRequest" ADD COLUMN "expiryReminderSentAt" TIMESTAMP(3);
