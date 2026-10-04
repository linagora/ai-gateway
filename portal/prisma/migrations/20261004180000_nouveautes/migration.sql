-- Nouveautés (spécification #124, ticket #130) : annonces des admins à tous les collaborateurs, signalées par la cloche
-- de l'en-tête, et accusés de lecture (« J'ai lu »), supprimés avec leur nouveauté.
CREATE TYPE "NewsCategory" AS ENUM ('MODELES', 'PRIX', 'FONCTIONNALITES', 'SERVICE');

CREATE TABLE "NewsItem" (
    "id" TEXT NOT NULL,
    "category" "NewsCategory" NOT NULL,
    "titleFr" TEXT NOT NULL,
    "summaryFr" TEXT NOT NULL,
    "bodyFr" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT NOT NULL,

    CONSTRAINT "NewsItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "NewsReceipt" (
    "newsItemId" TEXT NOT NULL,
    "uid" TEXT NOT NULL,
    "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NewsReceipt_pkey" PRIMARY KEY ("newsItemId","uid")
);

ALTER TABLE "NewsReceipt" ADD CONSTRAINT "NewsReceipt_newsItemId_fkey" FOREIGN KEY ("newsItemId") REFERENCES "NewsItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
