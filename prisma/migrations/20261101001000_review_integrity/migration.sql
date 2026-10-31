-- Task 0.4 — one review per user per product, plus the verified-purchase flag.
--
-- Pre-check to run manually before deploying (never auto-delete):
--   SELECT "userId", "productId", COUNT(*) FROM "Review" GROUP BY 1, 2 HAVING COUNT(*) > 1;
--     -- must return 0 rows. Reconcile duplicates by hand (keep the newest)
--     -- before this index is created; otherwise CREATE UNIQUE INDEX fails.

ALTER TABLE "Review" ADD COLUMN "verifiedPurchase" BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX "Review_userId_productId_key" ON "Review"("userId", "productId");
