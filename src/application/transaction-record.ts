import type { MoneyProps } from '../domain/money.js';
import type { FailureCode } from '../domain/errors.js';
import type { WagerTransaction, WagerTransactionStatus } from '../domain/wager-transaction.js';

export interface TransactionResult extends Record<string,unknown> {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps;
  idempotentReplay: boolean;
  failureCode?: FailureCode;
}
export interface RecordedResult { status: number; body: TransactionResult }
export interface TransactionRecord {
  transaction: WagerTransaction;
  firstResult: RecordedResult | undefined;
  terminalResult: RecordedResult | undefined;
  referenceAttempts: number;
  nextReferenceAttemptAt: Date | undefined;
  referenceExpiresAt: Date | undefined;
}
