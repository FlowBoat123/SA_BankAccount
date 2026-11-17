-- Nullable for legacy requests and transfer ledger entries. PostgreSQL permits
-- multiple NULL keys; non-null keys are unique across deposit/withdraw per account.
ALTER TABLE "financial_transactions" ADD COLUMN "idempotency_key" VARCHAR(128);
CREATE UNIQUE INDEX "financial_transactions_account_id_idempotency_key_key"
  ON "financial_transactions"("account_id", "idempotency_key");
