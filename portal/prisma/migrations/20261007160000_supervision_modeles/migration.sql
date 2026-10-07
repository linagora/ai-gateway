-- Supervision des modèles (ticket #142) : état de chaque modèle visible du catalogue, tenu par la sonde régulière
-- (SUPERVISION_INTERVAL_MINUTES), et alerte de panne envoyée aux admins (une seule par panne, puis un courriel au rétablissement).
CREATE TABLE "ModelHealth" (
    "modelName" TEXT NOT NULL,
    "healthy" BOOLEAN NOT NULL,
    "since" TIMESTAMP(3) NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL,
    "latencyMs" INTEGER,
    "httpStatus" INTEGER,
    "error" TEXT,
    "errorCode" TEXT,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "alertedAt" TIMESTAMP(3),

    CONSTRAINT "ModelHealth_pkey" PRIMARY KEY ("modelName")
);
