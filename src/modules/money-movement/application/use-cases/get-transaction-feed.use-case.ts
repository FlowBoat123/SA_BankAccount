import { ValidationError } from '../../../../common/domain/errors/common.errors';
import { AccountNotFoundError } from '../../domain/errors';
import { TransactionFeedFilter, TransactionFeedQueryPort, TransactionFeedResult } from '../ports/transaction-query.port';

/** Sequential history browsing: no OFFSET and no exact COUNT on each page. */
export class GetTransactionFeedUseCase {
  constructor(private readonly query: TransactionFeedQueryPort) {}

  async execute(command: TransactionFeedFilter & { userId: string }): Promise<TransactionFeedResult> {
    if (await this.query.findAccountOwner(command.accountId) !== command.userId) {
      throw new AccountNotFoundError();
    }
    if (command.from && command.to && command.from > command.to) {
      throw new ValidationError([{ field: 'from', reason: 'must_not_exceed_to' }]);
    }
    return this.query.findTransactionFeed(command);
  }
}
