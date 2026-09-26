-- Résiliations (spécification #51, ticket #58) : demande de résiliation (origine, auteur, date, motif), alerte unique
-- quand elle n'est pas déclarée dans le délai de retrait, et date de résiliation.
-- CreateEnum
CREATE TYPE "TerminationOrigin" AS ENUM ('RESPONSABLE', 'ADMIN', 'SORTIE');

-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN     "terminatedOn" TIMESTAMP(3),
ADD COLUMN     "terminationAlertSentAt" TIMESTAMP(3),
ADD COLUMN     "terminationOrigin" "TerminationOrigin",
ADD COLUMN     "terminationReason" TEXT,
ADD COLUMN     "terminationRequestedAt" TIMESTAMP(3),
ADD COLUMN     "terminationRequestedBy" TEXT;

