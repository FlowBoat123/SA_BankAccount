import { AppError, ErrorDetail } from '../../../../common/domain/errors/app.error';

export class InsufficientFundsError extends AppError {
  readonly errorCode = 'INSUFFICIENT_FUNDS';
  readonly httpStatus = 409;

  constructor(message = 'Insufficient funds', details?: ErrorDetail[]) {
    super(
      message,
      details ?? [{ field: 'amount', reason: 'exceeds_available_balance' }],
    );
  }
}

export class AccountNotFoundError extends AppError {
  readonly errorCode = 'ACCOUNT_NOT_FOUND';
  readonly httpStatus = 404;

  constructor(message = 'Account not found') {
    super(message);
  }
}

export class AccountClosedError extends AppError {
  readonly errorCode = 'ACCOUNT_NOT_ACTIVE';
  readonly httpStatus = 409;

  constructor(message = 'Account is closed or not active') {
    super(message);
  }
}

export class SameSourceDestinationError extends AppError {
  readonly errorCode = 'SAME_ACCOUNT_TRANSFER';
  readonly httpStatus = 400;

  constructor(message = 'Source and destination accounts must be different') {
    super(message);
  }
}

export class IdempotencyKeyReusedError extends AppError {
  readonly errorCode = 'IDEMPOTENCY_KEY_REUSED';
  readonly httpStatus = 409;

  constructor(message = 'Idempotency key has already been used with different parameters') {
    super(message);
  }
}

export class TransactionBusyError extends AppError {
  readonly errorCode = 'TRANSACTION_BUSY';
  readonly httpStatus = 503;

  constructor() {
    super('Transaction could not complete after a bounded retry; retry later');
  }
}

export class TransferOverloadedError extends AppError {
  readonly errorCode = 'TRANSFER_OVERLOADED';
  readonly httpStatus = 503;

  constructor() {
    super('Transfer queue is busy. Retry with the same idempotency key.');
  }
}
