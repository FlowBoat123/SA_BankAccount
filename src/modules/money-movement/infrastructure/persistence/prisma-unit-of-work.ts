import { Injectable } from "@nestjs/common";
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
  constructor(private readonly prisma: PrismaService) {}

  async execute<T>(
    work: (ctx: MoneyMovementTransactionContext) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this.prisma.$transaction(async (tx) => {
          const ctx = this.buildContext(tx);
          return work(ctx);
        });
      } catch (error) {
        // Only retry errors that certify this transaction was aborted. Never
        // retry connection/commit-ambiguity errors, constraints or business errors.
        const aborted = error instanceof Prisma.PrismaClientKnownRequestError && (
          error.code === 'P2034' ||
          (error.code === 'P2028' && /expired transaction|transaction[^\n]*expired/i.test(
            error.message + ' ' + String(error.meta?.error ?? ''),
          ))
        );
        if (!aborted) throw error;
        if (attempt === 1) throw new TransactionBusyError();
        // PostgreSQL/Prisma has rolled back before $transaction rejects. A small
        // jitter prevents immediately joining the same hot-row queue again.
        await new Promise(resolve => setTimeout(resolve, 10 + Math.random() * 30));
      }
    }
    throw new TransactionBusyError();
  }

  private buildContext(tx: PrismaTx): MoneyMovementTransactionContext {
    return {
      accounts: {
        lockForUpdate: async (
          accountId: string,
        ): Promise<AccountSnapshot | null> => {
          const rows = await tx.$queryRaw<RawAccountLockRow[]>(
            Prisma.sql`
              SELECT  
                id,
                user_id AS "userId",
                current_balance::text AS "currentBalance",
                status  
              FROM bank_accounts
              WHERE id = ${accountId}
              FOR UPDATE
            `,
          );
          return rows[0] ?? null;
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
            },
          });
          return { ...record, amount: record.amount.toString(), balanceAfter: record.balanceAfter.toString() };
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
}
