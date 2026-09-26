-- Demandes d'abonnement (spécification #51, ticket #54) : un nouveau type de demande, relié à l'offre demandée.
ALTER TYPE "RequestKind" ADD VALUE 'ABONNEMENT';

ALTER TABLE "AccessRequest" ADD COLUMN "offerId" TEXT;

ALTER TABLE "AccessRequest" ADD CONSTRAINT "AccessRequest_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "SubscriptionOffer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
