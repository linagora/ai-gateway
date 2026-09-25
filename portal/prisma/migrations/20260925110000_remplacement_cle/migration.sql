-- Nombre de remplacements d'une clé perdue : suffixe -2, -3… de l'alias.
ALTER TABLE "AccessRequest" ADD COLUMN "keyReplacements" INTEGER NOT NULL DEFAULT 0;
