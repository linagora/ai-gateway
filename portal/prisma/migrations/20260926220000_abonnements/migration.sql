-- Abonnements déclarés (spécification #51, ticket #55) : l'entité à part, reliée à sa demande, et le statut « Déclarée » d'une demande.
-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIF', 'A_RESILIER', 'RESILIE');

-- AlterEnum
ALTER TYPE "RequestStatus" ADD VALUE 'DECLAREE';

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "offerId" TEXT NOT NULL,
    "holderUid" TEXT NOT NULL,
    "holderEmail" TEXT NOT NULL,
    "holderName" TEXT,
    "teamId" TEXT NOT NULL,
    "teamAlias" TEXT NOT NULL,
    "accountEmail" TEXT NOT NULL,
    "subscribedAt" TIMESTAMP(3) NOT NULL,
    "monthlyAmountEur" DECIMAL(65,30) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'ACTIF',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_requestId_key" ON "Subscription"("requestId");

-- CreateIndex
CREATE INDEX "Subscription_holderUid_idx" ON "Subscription"("holderUid");

-- CreateIndex
CREATE INDEX "Subscription_teamId_idx" ON "Subscription"("teamId");

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "AccessRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "SubscriptionOffer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

