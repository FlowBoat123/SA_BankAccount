import { Money } from '../../../../common/domain/value-objects/money.value-object';
import { ValidationError } from '../../../../common/domain/errors/common.errors';
import { 
  UnitOfWorkPort, 
  MoneyMovementTransactionContext,
  TransferExecutionResult 
} from '../ports/unit-of-work.port';
import { 
  AccountNotFoundError, 
  AccountClosedError, 
  InsufficientFundsError, 
  SameSourceDestinationError,
  IdempotencyKeyReusedError
} from '../../domain/errors';

export interface TransferMoneyCommand {
  sourceAccountId: string;
  destinationAccountNumber: string;
  initiatedByUserId: string; 
  amount: string;
  idempotencyKey: string;   
  description?: string;
}

const MAX_VND = 999_999_999_999_999_999n;

export class TransferMoneyUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWorkPort,
  ) {}

  async execute(command: TransferMoneyCommand): Promise<TransferExecutionResult> {
    return this.unitOfWork.execute(async (ctx: MoneyMovementTransactionContext) => {
      const destSnapshot = await ctx.accounts.findByAccountNumber(command.destinationAccountNumber);
      if (!destSnapshot) {
        throw new AccountNotFoundError('Destination account not found');
      }

      if (destSnapshot.id === command.sourceAccountId) {
        throw new SameSourceDestinationError();
      }

      const locked = await ctx.accounts.lockManyForUpdate([command.sourceAccountId, destSnapshot.id]);
      const sourceAccount = locked.find(account => account.id === command.sourceAccountId);
      const destAccount = locked.find(account => account.id === destSnapshot.id);

      if (!sourceAccount || sourceAccount.userId !== command.initiatedByUserId) {
        throw new AccountNotFoundError('Source account not found'); 
      }
      // Authorize ownership before returning a previous result. Account state
      // only gates new transfers, not replay of an already completed transfer.
      const existingTransfer = await ctx.transfers.findBySourceAndIdempotencyKey(
        command.sourceAccountId,
        command.idempotencyKey,
      );

      if (existingTransfer) {
        if (existingTransfer.destinationAccountId !== destSnapshot.id ||
            existingTransfer.amount.toString() !== Money.fromString(command.amount, { allowZero: false }).toDecimalString() ||
            existingTransfer.description !== (command.description ?? null)) {
          throw new IdempotencyKeyReusedError();
        }
        return { transfer: existingTransfer, isReplay: true };
      }

      if (sourceAccount.status === 'CLOSED') {
        throw new AccountClosedError('Source account is closed');
      }

      if (!destAccount || destAccount.status === 'CLOSED') {
        throw new AccountNotFoundError('Destination account not found');
      }

      const sourceBalance = Money.fromString(sourceAccount.currentBalance);
      const destBalance = Money.fromString(destAccount.currentBalance);
      const transferAmount = Money.fromString(command.amount, { allowZero: false });

      if (!sourceBalance.isGreaterThanOrEqual(transferAmount)) {
        throw new InsufficientFundsError(); 
      }

      const newSourceBalance = sourceBalance.subtract(transferAmount).toDecimalString();
      const newDestBalanceMoney = destBalance.add(transferAmount);
      if (BigInt(newDestBalanceMoney.toDecimalString()) > MAX_VND) {
        throw new ValidationError([
          { field: 'amount', reason: 'amount_out_of_range' },
        ]);
      }
      const newDestBalance = newDestBalanceMoney.toDecimalString();

      await ctx.accounts.updateBalances([
        { accountId: sourceAccount.id, balance: newSourceBalance },
        { accountId: destAccount.id, balance: newDestBalance },
      ]);

      const transferRecord = await ctx.transfers.create({
        sourceAccountId: sourceAccount.id,
        destinationAccountId: destAccount.id,
        initiatedByUserId: command.initiatedByUserId,
        amount: command.amount,
        idempotencyKey: command.idempotencyKey,
        description: command.description ?? null,
      });

      await ctx.transactions.createMany([{
        accountId: sourceAccount.id,
        transferId: transferRecord.id,
        transactionType: 'DEBIT',
        referenceType: 'TRANSFER_OUT',
        amount: command.amount,
        balanceAfter: newSourceBalance,
        description: command.description ?? null,
      }, {
        accountId: destAccount.id,
        transferId: transferRecord.id,
        transactionType: 'CREDIT',
        referenceType: 'TRANSFER_IN',
        amount: command.amount,
        balanceAfter: newDestBalance,
        description: command.description ?? null,
      }]);

      return { transfer: transferRecord, isReplay: false };
    });
  }
}
