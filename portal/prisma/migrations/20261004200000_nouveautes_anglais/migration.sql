-- Nouveautés en anglais (spécification #124, ticket #133) : titre, résumé et texte facultatifs, repli sur le français
-- champ par champ.
ALTER TABLE "NewsItem" ADD COLUMN "titleEn" TEXT,
ADD COLUMN "summaryEn" TEXT,
ADD COLUMN "bodyEn" TEXT;
