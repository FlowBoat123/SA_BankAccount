import { Money } from '../../../../common/domain/value-objects/money.value-object';
import { ValidationError } from '../../../../common/domain/errors/common.errors';
import { UnitOfWorkPort, TransactionExecutionResult, TransactionType } from '../ports/unit-of-work.port';
import { AccountNotFoundError, AccountClosedError, InsufficientFundsError, IdempotencyKeyReusedError } from '../../domain/errors';

export interface CashMovementCommand {
  accountId: string;
  userId: string;
  amount: string;
  description?: string;
  /** Omitted keys retain the legacy behavior: each call is a new operation. */
  idempotencyKey?: string;
}

export async function executeCashMovement(
  unitOfWork: UnitOfWorkPort,
  command: CashMovementCommand,
  type: TransactionType,
): Promise<TransactionExecutionResult> {
  const key = command.idempotencyKey?.trim();
  if (key !== undefined && (key.length < 16 || key.length > 128)) {
    throw new ValidationError([{ field: 'Idempotency-Key', reason: 'length_must_be_16_to_128' }]);
  }
  return unitOfWork.execute(async ctx => {
    // Serialize all money writes on this account; authorize before replay.
    const account = await ctx.accounts.lockForUpdate(command.accountId);
    if (!account || account.userId !== command.userId) throw new AccountNotFoundError();
    const amount = Money.fromString(command.amount, { allowZero: false });
    const normalizedAmount = amount.toDecimalString();
    const description = command.description ?? null;
    if (key !== undefined) {
      const previous = await ctx.transactions.findByAccountAndIdempotencyKey(account.id, key);
      if (previous) {
        if (previous.transactionType !== type || previous.amount !== normalizedAmount ||
            previous.description !== description) throw new IdempotencyKeyReusedError();
        return { transaction: previous, isReplay: true };
      }
    }
    if (account.status === 'CLOSED') throw new AccountClosedError();
    const current = Money.fromString(account.currentBalance);
    if (type === 'DEBIT' && !current.isGreaterThanOrEqual(amount)) throw new InsufficientFundsError();
    const next = type === 'CREDIT' ? current.add(amount) : current.subtract(amount);
    if (BigInt(next.toDecimalString()) > 999_999_999_999_999_999n) {
      throw new ValidationError([{ field: 'amount', reason: 'amount_out_of_range' }]);
    }
    const newBalance = next.toDecimalString();
    await ctx.accounts.updateBalance(account.id, newBalance);
    const transaction = await ctx.transactions.create({
      accountId: account.id, transactionType: type,
      referenceType: type === 'CREDIT' ? 'CASH_DEPOSIT' : 'CASH_WITHDRAWAL',
      amount: normalizedAmount, balanceAfter: newBalance, description, idempotencyKey: key,
    });
    // Key, ledger entry and balance commit atomically; rollback reserves no key.
    return { transaction, isReplay: false };
  });
}
