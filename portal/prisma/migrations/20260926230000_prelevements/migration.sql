-- Prélèvements des abonnements (spécification #51, ticket #57) : un par abonnement et par date anniversaire.
-- CreateTable
CREATE TABLE "SubscriptionCharge" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "chargedOn" TIMESTAMP(3) NOT NULL,
    "amountEur" DECIMAL(65,30) NOT NULL,
    "teamId" TEXT NOT NULL,
    "teamAlias" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubscriptionCharge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SubscriptionCharge_teamId_idx" ON "SubscriptionCharge"("teamId");

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionCharge_subscriptionId_chargedOn_key" ON "SubscriptionCharge"("subscriptionId", "chargedOn");

-- AddForeignKey
ALTER TABLE "SubscriptionCharge" ADD CONSTRAINT "SubscriptionCharge_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

