-- Alertes de budget d'équipe (F-43, ticket #43) : seuil déjà annoncé pour la période en cours, pour n'envoyer chaque
-- alerte qu'une fois par période.
CREATE TABLE "TeamBudgetAlert" (
    "teamId" TEXT NOT NULL,
    "resetAt" TIMESTAMP(3),
    "budget" DECIMAL(65,30) NOT NULL,
    "level" INTEGER NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeamBudgetAlert_pkey" PRIMARY KEY ("teamId")
);
