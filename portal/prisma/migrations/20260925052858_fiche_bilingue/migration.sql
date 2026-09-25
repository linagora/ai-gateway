-- Fiche de modèle bilingue (ticket #6) : textes en français et en anglais, cas d'usage et
-- recommandations en liste fermée. Les fiches existantes sont reprises sans perte : le nom et la
-- description deviennent les valeurs françaises, la description et l'ancien texte des cas d'usage
-- forment la description longue. La catégorie et l'hébergement disparaissent (hébergement : fourni
-- par la passerelle).

-- CreateEnum
CREATE TYPE "UseCase" AS ENUM ('WRITING', 'CODING', 'DOCUMENT_ANALYSIS', 'TRANSLATION', 'EXTRACTION', 'REASONING', 'STRUCTURED_DECISIONS');

-- AlterTable
ALTER TABLE "CatalogEntry" RENAME COLUMN "displayName" TO "displayNameFr";
ALTER TABLE "CatalogEntry" RENAME COLUMN "description" TO "shortDescriptionFr";
ALTER TABLE "CatalogEntry" RENAME COLUMN "useCases" TO "useCasesText";
ALTER TABLE "CatalogEntry"
    ADD COLUMN "displayNameEn" TEXT,
    ADD COLUMN "shortDescriptionEn" TEXT,
    ADD COLUMN "longDescriptionFr" TEXT,
    ADD COLUMN "longDescriptionEn" TEXT,
    ADD COLUMN "limitationsFr" TEXT,
    ADD COLUMN "limitationsEn" TEXT,
    ADD COLUMN "useCases" "UseCase"[] DEFAULT ARRAY[]::"UseCase"[],
    ADD COLUMN "recommendedFor" "UseCase"[] DEFAULT ARRAY[]::"UseCase"[];
UPDATE "CatalogEntry"
    SET "longDescriptionFr" = "shortDescriptionFr" || COALESCE(E'\n\nCas d''usage : ' || NULLIF("useCasesText", ''), '');
ALTER TABLE "CatalogEntry" ALTER COLUMN "longDescriptionFr" SET NOT NULL;
ALTER TABLE "CatalogEntry" DROP COLUMN "useCasesText", DROP COLUMN "category", DROP COLUMN "hosting";
