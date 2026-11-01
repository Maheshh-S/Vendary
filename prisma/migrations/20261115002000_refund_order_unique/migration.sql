-- Phase 1 deviation from the plan: the task described a plain `Refund(orderId)`
-- index, but Phase 1 supports exactly one full refund per order (partial
-- refunds are deferred). The unique constraint is the refund claim's race
-- guard: two concurrent cancels/refunds cannot both create a ledger row and
-- call Razorpay. Retrying a `failed` refund updates the same row.
DROP INDEX "Refund_orderId_idx";

CREATE UNIQUE INDEX "Refund_orderId_key" ON "Refund"("orderId");
