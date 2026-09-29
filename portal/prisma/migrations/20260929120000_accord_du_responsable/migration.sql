-- Validation en deux temps des demandes d'abonnement (spécification #93, ticket #95) : l'accord d'un responsable de
-- l'équipe, avec son auteur, sa date et un commentaire facultatif, précède l'approbation par un admin.
ALTER TYPE "RequestStatus" ADD VALUE 'ACCORD_RESPONSABLE' AFTER 'A_COMPLETER';

ALTER TABLE "AccessRequest" ADD COLUMN "agreedBy" TEXT,
ADD COLUMN "agreedAt" TIMESTAMP(3),
ADD COLUMN "agreementComment" TEXT;
