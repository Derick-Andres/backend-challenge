import { DomainValidationError } from './errors.js';
import type { FailureCode } from './errors.js';
import { IntegrationEvent } from './integration-event.js';
import type { EventContext, IntegrationEventProps } from './integration-event.js';
import type { MoneyProps } from './money.js';
import { WagerTransactionStatus } from './wager-transaction.js';
import type { WagerTransaction, WagerTransactionKind } from './wager-transaction.js';
import type { Wallet } from './wallet.js';
import type { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry.js';

export interface TransactionEventData {
  transactionId: string;
  walletId: string;
  playerId: string;
  kind: WagerTransactionKind;
  status: WagerTransactionStatus;
  money: MoneyProps;
  providerId?: string;
  externalTransactionId?: string;
  roundId?: string;
  gameId?: string;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
}

function transactionData(tx: WagerTransaction): TransactionEventData {
  return {
    transactionId: tx.id, walletId: tx.walletId, playerId: tx.playerId, kind: tx.kind, status: tx.status, money: tx.money.toJSON(),
    ...(tx.providerId === undefined ? {} : { providerId: tx.providerId }),
    ...(tx.externalTransactionId === undefined ? {} : { externalTransactionId: tx.externalTransactionId }),
    ...(tx.roundId === undefined ? {} : { roundId: tx.roundId }),
    ...(tx.gameId === undefined ? {} : { gameId: tx.gameId }),
    ...(tx.referenceExternalTransactionId === undefined ? {} : { referenceExternalTransactionId: tx.referenceExternalTransactionId }),
    ...(tx.referenceTransactionId === undefined ? {} : { referenceTransactionId: tx.referenceTransactionId }),
  };
}

export class WagerTransactionProcessed extends IntegrationEvent<TransactionEventData & { processedAt: string }> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;
  private constructor(props: IntegrationEventProps<TransactionEventData & { processedAt: string }>) { super(props); Object.freeze(this); }
  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    if (tx.status !== WagerTransactionStatus.Processed || tx.processedAt === undefined) throw new DomainValidationError('Evento exige transação PROCESSED');
    return new WagerTransactionProcessed({ ...ctx, aggregateId: tx.id, data: { ...transactionData(tx), processedAt: tx.processedAt.toISOString() } });
  }
}

export class WagerTransactionRejected extends IntegrationEvent<TransactionEventData & { failureCode: FailureCode }> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;
  private constructor(props: IntegrationEventProps<TransactionEventData & { failureCode: FailureCode }>) { super(props); Object.freeze(this); }
  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    if (tx.status !== WagerTransactionStatus.Rejected || tx.failureCode === undefined) throw new DomainValidationError('Evento exige transação REJECTED com failureCode');
    return new WagerTransactionRejected({ ...ctx, aggregateId: tx.id, data: { ...transactionData(tx), failureCode: tx.failureCode } });
  }
}

export class WagerTransactionPendingReference extends IntegrationEvent<TransactionEventData & { referenceExternalTransactionId: string }> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;
  private constructor(props: IntegrationEventProps<TransactionEventData & { referenceExternalTransactionId: string }>) { super(props); Object.freeze(this); }
  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    if (tx.status !== WagerTransactionStatus.PendingReference || tx.referenceExternalTransactionId === undefined) throw new DomainValidationError('Evento exige PENDING_REFERENCE');
    return new WagerTransactionPendingReference({ ...ctx, aggregateId: tx.id, data: { ...transactionData(tx), referenceExternalTransactionId: tx.referenceExternalTransactionId } });
  }
}

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;
  private constructor(props: IntegrationEventProps<WalletBalanceChangedData>) { super(props); Object.freeze(this); }
  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    if (entry.walletId !== wallet.id || entry.walletVersion !== wallet.version || entry.money.currency !== wallet.currency
      || !entry.money.isPositive() || !entry.isBalanced() || !entry.balanceAfter.equals(wallet.balance)) {
      throw new DomainValidationError('Evento exige lançamento correspondente ao saldo e versão atuais');
    }
    return new WalletBalanceChanged({ ...ctx, aggregateId: wallet.id, data: {
      walletId: wallet.id, transactionId: entry.transactionId, direction: entry.direction, money: entry.money.toJSON(),
      balanceBefore: entry.balanceBefore.toJSON(), balanceAfter: entry.balanceAfter.toJSON(), walletVersion: entry.walletVersion,
    } });
  }
}
