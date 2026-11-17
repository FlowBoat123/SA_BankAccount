import { UnitOfWorkPort, TransactionEntryRecord, TransactionExecutionResult } from '../ports/unit-of-work.port';
import { CashMovementCommand, executeCashMovement } from './execute-cash-movement';

export interface DepositMoneyCommand extends CashMovementCommand {}

export class DepositMoneyUseCase {
  constructor(private readonly unitOfWork: UnitOfWorkPort) {}

  async execute(command: DepositMoneyCommand): Promise<TransactionEntryRecord> {
    return (await this.executeWithResult(command)).transaction;
  }

  executeWithResult(command: DepositMoneyCommand): Promise<TransactionExecutionResult> {
    return executeCashMovement(this.unitOfWork, command, 'CREDIT');
  }
}
