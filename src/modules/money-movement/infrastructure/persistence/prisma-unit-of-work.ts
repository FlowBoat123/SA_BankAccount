import { Injectable, Optional } from "@nestjs/common";
import { performance } from 'node:perf_hooks';
import { MoneyMovementTelemetry } from '@src/common/observability/money-movement-telemetry';
import { Prisma } from "@prisma/client";
import { PrismaService } from "@src/infrastructure/prisma";
import { TransactionBusyError } from '../../domain/errors';
import {
  AccountSnapshot,
  CreateTransactionEntryInput,
  CreateTransferInput,
  MoneyMovementTransactionContext,
  TransactionEntryRecord,
  TransferRecord,
  UnitOfWorkPort,
} from "../../application/ports/unit-of-work.port";


type PrismaTx = Prisma.TransactionClient;

interface RawAccountLockRow {
  id: string;
  userId: string;
  currentBalance: string;
  status: "ACTIVE" | "CLOSED";
}

@Injectable()
export class PrismaUnitOfWork implements UnitOfWorkPort {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly telemetry: MoneyMovementTelemetry = new MoneyMovementTelemetry(),
  ) {}

  async execute<T>(
    work: (ctx: MoneyMovementTransactionContext) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const start = performance.now();
      let settled = start;
      let callbackEnd: number | undefined;
      this.telemetry.increment('attempts');
      try {
        const result = await this.prisma.$transaction(async (tx) => {
          const entered = performance.now();
          // Includes pool acquisition, BEGIN and Prisma overhead; not pure pool wait.
          this.telemetry.observe('transaction_start', entered - start);
          const ctx = this.buildContext(tx);
          try { return await work(ctx); }
          finally {
            callbackEnd = performance.now();
            this.telemetry.observe('transaction_callback', callbackEnd - entered);
          }
        });
        settled = performance.now();
        this.telemetry.increment('committed');
        return result;
      } catch (error) {
        settled = performance.now();
        // Counts rejected attempts, including failure to start, not proof of rollback
        // for transport/ambiguous commit errors. Those are never retried.
        this.telemetry.increment('rejected');
        // Only retry errors that certify this transaction was aborted. Never
        // retry connection/commit-ambiguity errors, constraints or business errors.
        const aborted = error instanceof Prisma.PrismaClientKnownRequestError && (
          error.code === 'P2034' ||
          (error.code === 'P2028' && /expired transaction|transaction[^\n]*expired/i.test(
            error.message + ' ' + String(error.meta?.error ?? ''),
          ))
        );
        if (!aborted) throw error;
        if (attempt === 1) {
          this.telemetry.increment('retry_exhausted');
          throw new TransactionBusyError();
        }
        this.telemetry.increment('retries');
        // PostgreSQL/Prisma has rolled back before $transaction rejects. A small
        // jitter prevents immediately joining the same hot-row queue again.
        await new Promise(resolve => setTimeout(resolve, 10 + Math.random() * 30));
      } finally {
        this.telemetry.observe('transaction_attempt', settled - start);
        if (callbackEnd !== undefined) this.telemetry.observe('transaction_finish', settled - callbackEnd);
      }
    }
    throw new TransactionBusyError();
  }

  private buildContext(tx: PrismaTx): MoneyMovementTransactionContext {
    return {
      accounts: {
        lockManyForUpdate: async (accountIds): Promise<AccountSnapshot[]> => {
          if (!accountIds.length) return [];
          const start = performance.now();
          try {
            // IDs cannot change. Sorting before LockRows preserves the same lock
            // order for A->B and B->A, while avoiding a second client round trip.
            return await tx.$queryRaw<RawAccountLockRow[]>(Prisma.sql`
              SELECT id, user_id AS "userId", current_balance::text AS "currentBalance", status
              FROM bank_accounts
              WHERE id IN (${Prisma.join([...new Set(accountIds)])})
              ORDER BY id ASC
              FOR UPDATE
            `);
          } finally {
            this.telemetry.observe('account_lock_query', performance.now() - start);
          }
        },
        lockForUpdate: async (
          accountId: string,
        ): Promise<AccountSnapshot | null> => {
          const start = performance.now();
          try {
            const rows = await tx.$queryRaw<RawAccountLockRow[]>(
              Prisma.sql`
                SELECT id, user_id AS "userId",
                  current_balance::text AS "currentBalance", status
                FROM bank_accounts
                WHERE id = ${accountId}
                FOR UPDATE
              `,
            );
            return rows[0] ?? null;
          } finally {
            // SQL execution + row-lock wait + adapter overhead, not pure lock wait.
            this.telemetry.observe('account_lock_query', performance.now() - start);
          }
        },

        findByAccountNumber: async (
          accountNumber: string,
        ): Promise<AccountSnapshot | null> => {
          const acc = await tx.bankAccount.findUnique({
            where: { accountNumber },
            select: {
              id: true,
              userId: true,
              currentBalance: true,
              status: true,
              accountNumber: true,
            },
          });
          if (!acc) return null;
          return {
            id: acc.id,
            userId: acc.userId,
            currentBalance: acc.currentBalance.toString(),
            status: acc.status as "ACTIVE" | "CLOSED",
            accountNumber: acc.accountNumber,
          };
        },

        updateBalance: async (
          accountId: string,
          newBalance: string,
        ): Promise<void> => {
          await tx.bankAccount.update({
            where: { id: accountId },
            data: { currentBalance: newBalance },
          });
        },
        updateBalances: async (balances): Promise<void> => {
          if (balances.length === 0) return;
          // The use case already holds both row locks. One statement replaces
          // two network round trips without weakening transaction isolation.
          const values = balances.map(({ accountId, balance }) =>
            Prisma.sql`(${accountId}::text, ${balance}::numeric)`);
          const updated = await tx.$executeRaw(Prisma.sql`
            UPDATE bank_accounts AS a
            SET current_balance = b.balance, updated_at = CURRENT_TIMESTAMP
            FROM (VALUES ${Prisma.join(values)}) AS b(id, balance)
            WHERE a.id = b.id
          `);
          if (updated !== balances.length) throw new Error('Account update count mismatch');
        },
      },

      transactions: {
        findByAccountAndIdempotencyKey: async (accountId, key) => {
          const record = await tx.financialTransaction.findUnique({
            where: { uq_cash_idempotency: { accountId, idempotencyKey: key } },
          });
          return record ? this.toTransactionRecord(record) : null;
        },
        createMany: async (inputs): Promise<void> => {
          // Do not skip duplicates: any constraint failure must roll back money.
          await tx.financialTransaction.createMany({ data: inputs });
        },
        create: async (
          input: CreateTransactionEntryInput,
        ): Promise<TransactionEntryRecord> => {
          const record = await tx.financialTransaction.create({
            data: {
              accountId: input.accountId,
              transferId: input.transferId ?? null,
              transactionType: input.transactionType,
              referenceType: input.referenceType,
              amount: input.amount,
              balanceAfter: input.balanceAfter,
              description: input.description ?? null,
              idempotencyKey: input.idempotencyKey,
            },
          });
          return this.toTransactionRecord(record);
        },
      },

      transfers: {
        findBySourceAndIdempotencyKey: async (
          sourceAccountId: string,
          idempotencyKey: string,
        ): Promise<TransferRecord | null> => {
          const record = await tx.transfer.findUnique({
            where: {
              uq_transfer_idempotency: {
                sourceAccountId,
                idempotencyKey,
              },
            },
          });
          return record ? { ...record, amount: record.amount.toString() } : null;
        },

        create: async (input: CreateTransferInput): Promise<TransferRecord> => {
          const record = await tx.transfer.create({
            data: {
              sourceAccountId: input.sourceAccountId,
              destinationAccountId: input.destinationAccountId,
              initiatedByUserId: input.initiatedByUserId,
              amount: input.amount,
              description: input.description ?? null,
              idempotencyKey: input.idempotencyKey,
            },
          });
          return { ...record, amount: record.amount.toString() };
        },
      },
    };
  }

  private toTransactionRecord(record: {
    id: string; accountId: string; transferId: string | null;
    transactionType: 'CREDIT' | 'DEBIT'; referenceType: TransactionEntryRecord['referenceType'];
    amount: Prisma.Decimal; balanceAfter: Prisma.Decimal; status: string;
    description: string | null; createdAt: Date;
  }): TransactionEntryRecord {
    // Keep persistence-only idempotency keys out of HTTP/history responses.
    return {
      id: record.id, accountId: record.accountId, transferId: record.transferId,
      transactionType: record.transactionType, referenceType: record.referenceType,
      amount: record.amount.toString(), balanceAfter: record.balanceAfter.toString(),
      status: record.status, description: record.description, createdAt: record.createdAt,
    };
  }
}
