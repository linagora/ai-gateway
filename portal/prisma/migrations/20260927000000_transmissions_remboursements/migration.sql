-- Remboursements (retours de l'utilisateur du 2026-09-26) : transmission à la comptabilité d'une liste de prélèvements à
-- rembourser aux collaborateurs ; chaque prélèvement n'est transmis qu'une fois.
CREATE TABLE "ChargeTransmission" (
    "id" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "transmittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "transmittedBy" TEXT NOT NULL,
    "chargeCount" INTEGER NOT NULL,
    "totalEur" DECIMAL(65,30) NOT NULL,

    CONSTRAINT "ChargeTransmission_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "SubscriptionCharge" ADD COLUMN     "transmissionId" TEXT;

CREATE INDEX "SubscriptionCharge_transmissionId_idx" ON "SubscriptionCharge"("transmissionId");

ALTER TABLE "SubscriptionCharge" ADD CONSTRAINT "SubscriptionCharge_transmissionId_fkey" FOREIGN KEY ("transmissionId") REFERENCES "ChargeTransmission"("id") ON DELETE SET NULL ON UPDATE CASCADE;
