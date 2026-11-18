export const UNIT_OF_WORK = Symbol("UNIT_OF_WORK");

export type TransactionType = "CREDIT" | "DEBIT";

export type TransactionReferenceType =
  | "OPENING_DEPOSIT"
  | "CASH_DEPOSIT"
  | "CASH_WITHDRAWAL"
  | "TRANSFER_IN"
  | "TRANSFER_OUT";

export interface AccountSnapshot {
  id: string;
  userId: string;
  currentBalance: string;
  status: "ACTIVE" | "CLOSED";
  accountNumber?: string;
}

export interface CreateTransactionEntryInput {
  accountId: string;
  transferId?: string | null;
  transactionType: TransactionType;
  referenceType: TransactionReferenceType;
  amount: string;
  balanceAfter: string;
  description?: string | null;
  idempotencyKey?: string;
}

export interface TransactionEntryRecord {
  id: string;
  accountId: string;
  transferId: string | null;
  transactionType: TransactionType;
  referenceType: TransactionReferenceType;
  amount: string;
  balanceAfter: string;
  status: string;
  description: string | null;
  createdAt: Date;
}

export interface CreateTransferInput {
  sourceAccountId: string;
  destinationAccountId: string;
  initiatedByUserId: string;
  amount: string;
  description?: string | null;
  idempotencyKey: string;
}

export interface TransferRecord {
  id: string;
  sourceAccountId: string;
  destinationAccountId: string;
  initiatedByUserId: string;
  amount: string;
  description: string | null;
  idempotencyKey: string;
  status: string;
  createdAt: Date;
}

export interface PostTransferInput extends CreateTransferInput {
  sourceBalance: string;
  destinationBalance: string;
}

export interface TransferExecutionResult {
  transfer: TransferRecord;
  isReplay: boolean;
}

export interface TransactionExecutionResult {
  transaction: TransactionEntryRecord;
  isReplay: boolean;
}

export interface MoneyMovementTransactionContext {
  accounts: {
    lockForUpdate(accountId: string): Promise<AccountSnapshot | null>;
    /** Lock immutable account IDs in database ascending order in one statement. */
    lockManyForUpdate(accountIds: string[]): Promise<AccountSnapshot[]>;
    findByAccountNumber(accountNumber: string): Promise<AccountSnapshot | null>;
    updateBalance(accountId: string, newBalance: string): Promise<void>;
    /** Caller must already hold the account locks in ascending ID order. */
    updateBalances(balances: { accountId: string; balance: string }[]): Promise<void>;
  };

  transactions: {
    findByAccountAndIdempotencyKey(accountId: string, key: string): Promise<TransactionEntryRecord | null>;
    create(input: CreateTransactionEntryInput): Promise<TransactionEntryRecord>;
    createMany(inputs: CreateTransactionEntryInput[]): Promise<void>;
  };

  transfers: {
    /** Posts balances, transfer and both ledger entries while holding both account locks. */
    post?: (input: PostTransferInput) => Promise<TransferRecord>;
    findBySourceAndIdempotencyKey(
      sourceAccountId: string,
      idempotencyKey: string,
    ): Promise<TransferRecord | null>;

    create(input: CreateTransferInput): Promise<TransferRecord>;
  };
}

export interface UnitOfWorkPort {
  execute<T>(
    work: (ctx: MoneyMovementTransactionContext) => Promise<T>,
  ): Promise<T>;
}
