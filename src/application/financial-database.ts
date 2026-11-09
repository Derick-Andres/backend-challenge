import type { IntegrationEvent } from '../domain/integration-event.js';
import type { WagerTransaction } from '../domain/wager-transaction.js';
import type { Wallet } from '../domain/wallet.js';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry.js';
import type { Money } from '../domain/money.js';
import type { RecordedResult, TransactionRecord } from './transaction-record.js';
import type { ReferenceSchedule } from './reference-policy.js';
import type { InboxDelivery } from './inbox-delivery.js';
import type { InboxMessage } from '../domain/inbox-message.js';

export interface FinancialSession {
  claimInbox(delivery: InboxDelivery): Promise<InboxMessage>;
  completeInbox(message: InboxMessage, at: Date): Promise<void>;
  findWallet(id: string): Promise<Wallet | undefined>;
  lockWallet(id: string): Promise<Wallet | undefined>;
  insertWallet(wallet: Wallet): Promise<void>;
  saveWallet(wallet: Wallet): Promise<void>;
  insertTransaction(tx: WagerTransaction, result?: RecordedResult, schedule?: ReferenceSchedule): Promise<void>;
  saveTransaction(tx: WagerTransaction, result: RecordedResult | undefined, schedule: ReferenceSchedule): Promise<void>;
  lockTransaction(id: string): Promise<TransactionRecord | undefined>;
  findTransactionByKey(key: string): Promise<TransactionRecord | undefined>;
  findTransactionById(id: string): Promise<TransactionRecord | undefined>;
  findTransactionByExternal(providerId: string, externalId: string): Promise<TransactionRecord | undefined>;
  findProcessedReversals(referenceId: string): Promise<readonly WagerTransaction[]>;
  insertLedger(entry: WalletLedgerEntry): Promise<void>;
  enqueue(event: IntegrationEvent<unknown>): Promise<void>;
  ledgerPage(walletId: string, after: number, upper: number, count: number): Promise<readonly WalletLedgerEntry[]>;
}

export abstract class FinancialDatabase {
  abstract isPersistable(money: Money): boolean;
  abstract transaction<T>(work: (session: FinancialSession) => Promise<T>): Promise<T>;
  abstract dueReferences(now: Date, limit: number): Promise<readonly { id: string; walletId: string }[]>;
  abstract reconciliationSnapshot(id: string): Promise<{ wallet: Wallet; calculatedMinor: bigint; checkedEntries: number } | undefined>;
}
