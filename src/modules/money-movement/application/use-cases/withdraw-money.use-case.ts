import { UnitOfWorkPort, TransactionEntryRecord, TransactionExecutionResult } from '../ports/unit-of-work.port';
import { CashMovementCommand, executeCashMovement } from './execute-cash-movement';

export interface WithdrawMoneyCommand extends CashMovementCommand {}

export class WithdrawMoneyUseCase {
  constructor(private readonly unitOfWork: UnitOfWorkPort) {}

  async execute(command: WithdrawMoneyCommand): Promise<TransactionEntryRecord> {
    return (await this.executeWithResult(command)).transaction;
  }

  executeWithResult(command: WithdrawMoneyCommand): Promise<TransactionExecutionResult> {
    return executeCashMovement(this.unitOfWork, command, 'DEBIT');
  }
}
