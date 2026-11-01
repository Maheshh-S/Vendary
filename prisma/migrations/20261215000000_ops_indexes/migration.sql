-- Task 3.6 — operational indexes.
--
-- Already present from 20261115001000_catalog_indexes and intentionally kept:
--   OrderItem(productId)          → review purchase check / product delete
--   Order(status, createdAt)      → admin order list + stale-pending cleanup
--   Product(availability, createdAt) → /products?sort=newest (kept; the
--                                     composite below is a different prefix)
--
-- New: the featured storefront query filters availability + isFeatured and
-- orders by createdAt. The existing (availability, createdAt) index cannot
-- serve the isFeatured predicate without scanning every in-stock product.
-- CreateIndex
CREATE INDEX "Product_availability_isFeatured_createdAt_idx"
  ON "Product"("availability", "isFeatured", "createdAt");
