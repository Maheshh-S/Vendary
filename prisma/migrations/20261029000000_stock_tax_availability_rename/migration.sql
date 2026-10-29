-- Rename the misspelled enum type and column, add stock tracking and order tax.
ALTER TYPE "Avaiavility" RENAME TO "Availability";

ALTER TABLE "Product" RENAME COLUMN "avaiavility" TO "availability";

ALTER TABLE "Product" ADD COLUMN "stockQty" INTEGER NOT NULL DEFAULT 25;

ALTER TABLE "Order" ADD COLUMN "taxAmount" DECIMAL(10,2) NOT NULL DEFAULT 0;
