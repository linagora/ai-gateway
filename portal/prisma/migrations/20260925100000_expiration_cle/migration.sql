-- Date d'expiration de la clé émise, conservée par le portail (le remplacement d'une clé la reprend).
ALTER TABLE "AccessRequest" ADD COLUMN "keyExpiresAt" TIMESTAMP(3);
