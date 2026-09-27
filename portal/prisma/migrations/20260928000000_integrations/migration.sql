-- Intégrations (spécification #71, ticket #74) : applications tierces déclarées par un admin, qui agissent pour un
-- collaborateur par l'API du portail, et leurs clés publiques.
CREATE TYPE "IntegrationScope" AS ENUM ('LECTURE', 'DEMANDES', 'CLES');

CREATE TABLE "Integration" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "scopes" "IntegrationScope"[],
    "ipRanges" TEXT[],
    "rateLimitPerMinute" INTEGER NOT NULL DEFAULT 120,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Integration_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "IntegrationKey" (
    "id" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "kid" TEXT NOT NULL,
    "algorithm" TEXT NOT NULL,
    "publicKeyPem" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "removedAt" TIMESTAMP(3),
    "removedBy" TEXT,

    CONSTRAINT "IntegrationKey_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "IntegrationKey_integrationId_kid_key" ON "IntegrationKey"("integrationId", "kid");

ALTER TABLE "IntegrationKey" ADD CONSTRAINT "IntegrationKey_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
