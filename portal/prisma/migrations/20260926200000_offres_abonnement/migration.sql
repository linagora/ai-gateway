-- Offres d'abonnement (spécification #51, ticket #53) : tenues par le portail, présentées au catalogue.
CREATE TABLE "SubscriptionOffer" (
    "id" TEXT NOT NULL,
    "supplier" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "monthlyPriceEur" DECIMAL(65,30) NOT NULL,
    "dataLevel" "DataLevel" NOT NULL,
    "rulesFr" TEXT NOT NULL,
    "rulesEn" TEXT,
    "url" TEXT,
    "visible" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT NOT NULL,

    CONSTRAINT "SubscriptionOffer_pkey" PRIMARY KEY ("id")
);
