-- Phase 2 fix round 1 — enforce at most one default saved address per user.
--
-- The actions already clear the previous default inside the same transaction,
-- but two concurrent writers could both clear then write. This partial unique
-- index is the backstop; the actions map its P2002 to a CONFLICT asking the
-- user to refresh. Partial, so any number of non-default rows remain allowed.

CREATE UNIQUE INDEX "SavedAddress_userId_default_key"
    ON "SavedAddress"("userId")
    WHERE "isDefault";
