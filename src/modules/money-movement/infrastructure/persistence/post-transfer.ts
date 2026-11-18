import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { PostTransferInput, TransferRecord } from '../../application/ports/unit-of-work.port';

/** Both account locks and all domain checks must already be in place. */
export async function postTransfer(tx: Prisma.TransactionClient, input: PostTransferInput): Promise<TransferRecord> {
  const transferId = randomUUID();
  const debitId = randomUUID();
  const creditId = randomUUID();
  const description = input.description ?? null;
  const rows = await tx.$queryRaw<{ createdAt: Date; amount: string; entries: number }[]>(Prisma.sql`
    WITH updated AS (
      UPDATE bank_accounts a
      SET current_balance = b.balance, updated_at = CURRENT_TIMESTAMP
      FROM (VALUES
        (${input.sourceAccountId}::text, ${input.sourceBalance}::numeric),
        (${input.destinationAccountId}::text, ${input.destinationBalance}::numeric)
      ) AS b(id, balance)
      WHERE a.id = b.id
      RETURNING a.id
    ), posted AS (
      INSERT INTO transfers (
        id, source_account_id, destination_account_id, initiated_by_user_id,
        amount, description, idempotency_key
      )
      SELECT ${transferId}, ${input.sourceAccountId}, ${input.destinationAccountId},
        ${input.initiatedByUserId}, ${input.amount}::numeric, ${description}, ${input.idempotencyKey}
      WHERE (SELECT count(*) FROM updated) = 2
      RETURNING id, created_at, amount, description
    ), entries AS (
      INSERT INTO financial_transactions (
        id, account_id, transfer_id, transaction_type, reference_type, amount, balance_after, description
      )
      SELECT e.id, e.account_id, posted.id, e.type, e.reference, posted.amount, e.balance, posted.description
      FROM posted CROSS JOIN (VALUES
        (${debitId}, ${input.sourceAccountId}, 'DEBIT'::"TransactionType", 'TRANSFER_OUT'::"ReferenceType", ${input.sourceBalance}::numeric),
        (${creditId}, ${input.destinationAccountId}, 'CREDIT'::"TransactionType", 'TRANSFER_IN'::"ReferenceType", ${input.destinationBalance}::numeric)
      ) AS e(id, account_id, type, reference, balance)
      RETURNING id
    )
    SELECT created_at AS "createdAt", amount::text, (SELECT count(*)::int FROM entries) AS entries FROM posted
  `);
  const posted = rows[0];
  if (!posted || posted.entries !== 2) throw new Error('Transfer posting did not write both accounts and ledger entries');
  return {
    id: transferId, sourceAccountId: input.sourceAccountId, destinationAccountId: input.destinationAccountId,
    initiatedByUserId: input.initiatedByUserId, amount: posted.amount, description,
    idempotencyKey: input.idempotencyKey, status: 'COMPLETED', createdAt: posted.createdAt,
  };
}
