-- Phase 4B — search v2 (pg_trgm).
--
-- Trigram GIN indexes back both the similarity ranking and the ILIKE substring
-- predicates in `lib/search.ts`. The extension may be unavailable on a managed
-- Postgres tier the app is allowed to deploy to, so creation is attempted but
-- not required: without pg_trgm the indexes are skipped and the application
-- falls back to the plain ILIKE query (same matches, sequential scan).
DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pg_trgm unavailable (%); skipping trigram indexes, search will use ILIKE', SQLERRM;
  END;

  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "Product_name_trgm_idx" ON "Product" USING GIN ("name" gin_trgm_ops)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS "Product_tag_trgm_idx" ON "Product" USING GIN ("tag" gin_trgm_ops)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS "Product_description_trgm_idx" ON "Product" USING GIN ("description" gin_trgm_ops)';
  END IF;
END
$$;
