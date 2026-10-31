-- Task 0.4 — drop the unused Analytics model (no writer, no reader).
--
-- Pre-check to run manually before deploying:
--   SELECT COUNT(*) FROM "Analytics";
--     -- must be 0. This table never had a writer in the application; if it is
--     -- not empty, export the rows before running this migration.

DROP TABLE "Analytics";
