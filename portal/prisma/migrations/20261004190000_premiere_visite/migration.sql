-- Première visite d'un collaborateur (spécification #124, ticket #135) : elle fixe la fenêtre des 30 jours au-delà de
-- laquelle une nouveauté plus ancienne ne compte pas comme non lue pour lui.
CREATE TABLE "FirstVisit" (
    "uid" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FirstVisit_pkey" PRIMARY KEY ("uid")
);
