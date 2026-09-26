-- Renouvellement et changement d'offre (spécification #51, ticket #59) : statut du renouvellement approuvé, demandes de
-- résiliation nées de l'échéance ou du refus d'un renouvellement, abonnement d'origine d'une demande, rappels d'échéance.
ALTER TYPE "RequestStatus" ADD VALUE 'RENOUVELEE';

ALTER TYPE "TerminationOrigin" ADD VALUE 'ECHEANCE';
ALTER TYPE "TerminationOrigin" ADD VALUE 'RENOUVELLEMENT_REFUSE';

ALTER TABLE "AccessRequest" ADD COLUMN     "renewsSubscriptionId" TEXT,
ADD COLUMN     "replacesSubscriptionId" TEXT;

ALTER TABLE "Subscription" ADD COLUMN     "expiryReminderLead" INTEGER,
ADD COLUMN     "expiryReminderSentAt" TIMESTAMP(3);
