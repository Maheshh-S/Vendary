-- Task 0.4 — order integrity: typed status, DB-enforced payment idempotency,
-- and item snapshots that survive product deletion.
--
-- Pre-checks to run manually before deploying (never auto-reconcile):
--   SELECT "transactionId", COUNT(*) FROM "Order" GROUP BY 1 HAVING COUNT(*) > 1;
--     -- must return 0 rows: duplicates make the unique index (and payment
--     -- idempotency) fail. Reconcile those orders by hand first.
--   SELECT DISTINCT "status" FROM "Order";
--     -- must be a subset of ('pending','confirmed','shipped','delivered','cancelled','refunded');
--     -- any other value makes the enum cast below fail.
--
-- Deploy in a maintenance window or single-instance: the previous release
-- writes text statuses, which the cast rejects after this migration commits.

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('pending', 'confirmed', 'shipped', 'delivered', 'cancelled', 'refunded');

-- AlterEnum-safe conversion: keep existing rows, then restore the default.
ALTER TABLE "Order" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Order" ALTER COLUMN "status" TYPE "OrderStatus" USING ("status"::"OrderStatus");
ALTER TABLE "Order" ALTER COLUMN "status" SET DEFAULT 'pending';

-- A pending order is written before the client can pay, so paymentId starts empty.
ALTER TABLE "Order" ALTER COLUMN "paymentId" SET DEFAULT '';

-- Payment idempotency is enforced here, not by application reads.
ALTER TABLE "Order" ADD CONSTRAINT "Order_transactionId_key" UNIQUE ("transactionId");

-- Order line snapshots: the row must render even after the product is gone.
ALTER TABLE "OrderItem" ADD COLUMN "productName" TEXT;
ALTER TABLE "OrderItem" ADD COLUMN "productImage" TEXT;

UPDATE "OrderItem" oi
SET "productName" = p."name", "productImage" = p."thumbnail"
FROM "Product" p
WHERE oi."productId" = p."id";

-- Only orphaned rows (product already deleted) keep this placeholder.
UPDATE "OrderItem" SET "productName" = 'Unknown product' WHERE "productName" IS NULL;

ALTER TABLE "OrderItem" ALTER COLUMN "productName" SET NOT NULL;

ALTER TABLE "OrderItem" DROP CONSTRAINT "OrderItem_productId_fkey";
ALTER TABLE "OrderItem" ALTER COLUMN "productId" DROP NOT NULL;
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;
