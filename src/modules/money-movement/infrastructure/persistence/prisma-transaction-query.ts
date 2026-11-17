import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@src/infrastructure/prisma';
import { ValidationError } from '@src/common/domain/errors/common.errors';
import { TransactionFeedFilter, TransactionFeedQueryPort, TransactionFeedResult } from '../../application/ports/transaction-query.port';
import { 
  TransactionQueryPort, 
  TransactionFilter, 
  PaginatedTransactionsResult 
} from '../../application/ports/transaction-query.port';

@Injectable()
export class PrismaTransactionQuery implements TransactionQueryPort, TransactionFeedQueryPort {
  constructor(private readonly prisma: PrismaService) {}

  async findAccountOwner(accountId: string): Promise<string | null> {
    const account = await this.prisma.bankAccount.findUnique({
      where: { id: accountId },
      select: { userId: true },
    });
    return account ? account.userId : null;
  }

  async findTransactionFeed(filter: TransactionFeedFilter): Promise<TransactionFeedResult> {
    if (filter.cursor) {
      const anchor = await this.prisma.financialTransaction.findFirst({
        where: {
          id: filter.cursor, accountId: filter.accountId,
          ...(filter.type ? { transactionType: filter.type } : {}),
          createdAt: { gte: filter.from, lte: filter.to },
        },
        select: { id: true },
      });
      if (!anchor) throw new ValidationError([{ field: 'cursor', reason: 'not_in_filtered_account_history' }]);
    }
    type FeedRow = {
      id: string; accountId: string; transferId: string | null;
      transactionType: string; referenceType: string; amount: string;
      balanceAfter: string; status: string; description: string | null; createdAt: Date;
    };
    // Resolve the cursor timestamp inside PostgreSQL, preserving microseconds
    // that would be lost by converting it to a JavaScript Date before seeking.
    const rows = await this.prisma.$queryRaw<FeedRow[]>(Prisma.sql`
      SELECT id, account_id AS "accountId", transfer_id AS "transferId",
             transaction_type AS "transactionType", reference_type AS "referenceType",
             amount::text, balance_after::text AS "balanceAfter", status, description,
             created_at AS "createdAt"
      FROM financial_transactions
      WHERE account_id = ${filter.accountId}
        ${filter.type ? Prisma.sql`AND transaction_type = ${filter.type}::"TransactionType"` : Prisma.empty}
        ${filter.from ? Prisma.sql`AND created_at >= ${filter.from}` : Prisma.empty}
        ${filter.to ? Prisma.sql`AND created_at <= ${filter.to}` : Prisma.empty}
        ${filter.cursor ? Prisma.sql`AND (created_at, id) < (
          SELECT created_at, id FROM financial_transactions
          WHERE id = ${filter.cursor} AND account_id = ${filter.accountId}
        )` : Prisma.empty}
      ORDER BY created_at DESC, id DESC
      LIMIT ${filter.limit + 1}
    `);
    const hasMore = rows.length > filter.limit;
    const items = rows.slice(0, filter.limit).map(row => ({ ...row, createdAt: row.createdAt.toISOString() }));
    return { items, hasMore, nextCursor: hasMore ? items[items.length - 1].id : null };
  }

  async findTransactions(filter: TransactionFilter): Promise<PaginatedTransactionsResult> {
    const whereClause: Prisma.FinancialTransactionWhereInput = {
      accountId: filter.accountId,
    };

    if (filter.type) {
      whereClause.transactionType = filter.type;
    }

    if (filter.from || filter.to) {
      whereClause.createdAt = {};
      if (filter.from) {
        whereClause.createdAt.gte = filter.from;
      }
      if (filter.to) {
        whereClause.createdAt.lte = filter.to;
      }
    }

    const [total, records] = await Promise.all([
      this.prisma.financialTransaction.count({ where: whereClause }),
      this.prisma.financialTransaction.findMany({
        where: whereClause,
        orderBy: [
          { createdAt: 'desc' },
          { id: 'desc' },
        ],
        skip: (filter.page - 1) * filter.limit,
        take: filter.limit,
      }),
    ]);

    return {
      total,
      items: records.map((r) => ({
        id: r.id,
        accountId: r.accountId,
        transferId: r.transferId,
        transactionType: r.transactionType,
        referenceType: r.referenceType,
        amount: r.amount.toString(),
        balanceAfter: r.balanceAfter.toString(),
        status: r.status,
        description: r.description,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  }
}
