-- Task 1.2 — indexes for the catalog listing, the customer order list and the
-- admin order list. Every index maps 1:1 to a @@index in schema.prisma, so
-- Prisma migrate stays drift-free.
--
-- Product(availability, createdAt)  → GET /products?sort=newest
-- Product(categoryId, price)        → category + price filters/sort
-- Order(userId, createdAt)          → /my-orders
-- Order(status, createdAt)          → admin order list
-- OrderItem(orderId)                → order detail line load
-- OrderItem(productId)              → review purchase check / product delete
-- Review(productId, createdAt)      → product page review list

-- CreateIndex
CREATE INDEX "Product_availability_createdAt_idx" ON "Product"("availability", "createdAt");

-- CreateIndex
CREATE INDEX "Product_categoryId_price_idx" ON "Product"("categoryId", "price");

-- CreateIndex
CREATE INDEX "Order_userId_createdAt_idx" ON "Order"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Order_status_createdAt_idx" ON "Order"("status", "createdAt");

-- CreateIndex
CREATE INDEX "OrderItem_orderId_idx" ON "OrderItem"("orderId");

-- CreateIndex
CREATE INDEX "OrderItem_productId_idx" ON "OrderItem"("productId");

-- CreateIndex
CREATE INDEX "Review_productId_createdAt_idx" ON "Review"("productId", "createdAt");
