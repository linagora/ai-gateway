-- Cas d'usage ramenés de huit à quatre (décision du 2026-09-25) : rédaction et analyse, code, extraction et
-- automatisation, création d'images. Chaque fiche garde ses cas d'usage et ses recommandations, regroupés
-- sans doublon dans l'ordre où ils apparaissaient :
--   WRITING, DOCUMENT_ANALYSIS, TRANSLATION, TRANSCRIPTION, REASONING → WRITING_ANALYSIS
--   CODING                                                           → CODING
--   EXTRACTION, STRUCTURED_DECISIONS                                 → EXTRACTION_AUTOMATION
CREATE TYPE "UseCase_new" AS ENUM ('WRITING_ANALYSIS', 'CODING', 'EXTRACTION_AUTOMATION', 'IMAGE_CREATION');

CREATE FUNCTION pg_temp.cas_usage_regroupes(anciens text[]) RETURNS "UseCase_new"[] LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(array_agg(nouveau ORDER BY premier), ARRAY[]::"UseCase_new"[])
  FROM (
    SELECT nouveau, min(rang) AS premier
    FROM unnest(anciens) WITH ORDINALITY AS a(ancien, rang),
      LATERAL (SELECT (CASE ancien
        WHEN 'CODING' THEN 'CODING'
        WHEN 'EXTRACTION' THEN 'EXTRACTION_AUTOMATION'
        WHEN 'STRUCTURED_DECISIONS' THEN 'EXTRACTION_AUTOMATION'
        ELSE 'WRITING_ANALYSIS'
      END)::"UseCase_new" AS nouveau) AS n
    GROUP BY nouveau
  ) AS regroupes
$$;

ALTER TABLE "CatalogEntry" ALTER COLUMN "useCases" DROP DEFAULT, ALTER COLUMN "recommendedFor" DROP DEFAULT;
ALTER TABLE "CatalogEntry"
  ALTER COLUMN "useCases" TYPE "UseCase_new"[] USING pg_temp.cas_usage_regroupes("useCases"::text[]),
  ALTER COLUMN "recommendedFor" TYPE "UseCase_new"[] USING pg_temp.cas_usage_regroupes("recommendedFor"::text[]);
DROP FUNCTION pg_temp.cas_usage_regroupes(text[]);
DROP TYPE "UseCase";
ALTER TYPE "UseCase_new" RENAME TO "UseCase";
ALTER TABLE "CatalogEntry"
  ALTER COLUMN "useCases" SET DEFAULT ARRAY[]::"UseCase"[],
  ALTER COLUMN "recommendedFor" SET DEFAULT ARRAY[]::"UseCase"[];
