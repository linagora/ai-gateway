-- Renouvellement : la demande dont cette demande renouvelle la clé.
ALTER TABLE "AccessRequest" ADD COLUMN "renewsRequestId" TEXT;
