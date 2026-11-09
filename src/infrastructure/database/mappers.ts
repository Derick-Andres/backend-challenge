import { Money } from '../../domain/money.js';
import { Wallet } from '../../domain/wallet.js';
import { WalletLedgerEntry } from '../../domain/wallet-ledger-entry.js';
import { WagerTransaction } from '../../domain/wager-transaction.js';
import type { RecordedResult, TransactionRecord, TransactionResult } from '../../application/transaction-record.js';
import type { LedgerRow, TransactionRow, WalletRow } from './records.js';

export function walletFromRow(row: WalletRow): Wallet {
  return Wallet.rehydrate({ ...row, balance: Money.rehydrate(row.balanceMinor, row.currency) });
}
export function walletToRow(wallet: Wallet): WalletRow {
  return { id: wallet.id, playerId: wallet.playerId, currency: wallet.currency, balanceMinor: wallet.balance.minorUnits,
    version: wallet.version, createdAt: wallet.createdAt, updatedAt: wallet.updatedAt };
}
export function transactionToRow(tx: WagerTransaction): TransactionRow {
  return {
    id: tx.id, providerId: tx.providerId ?? null, externalTransactionId: tx.externalTransactionId ?? null, idempotencyKey: tx.idempotencyKey ?? null,
    payloadHash: tx.payloadHash ?? null, walletId: tx.walletId, playerId: tx.playerId, roundId: tx.roundId ?? null, gameId: tx.gameId ?? null,
    kind: tx.kind, amountMinor: tx.money.minorUnits, currency: tx.money.currency, referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
    referenceTransactionId: tx.referenceTransactionId ?? null, status: tx.status, failureCode: tx.failureCode ?? null, createdAt: tx.createdAt,
    processedAt: tx.processedAt ?? null, completedAt: tx.completedAt ?? null, firstHttpStatus: null, firstResponse: null, terminalResponse: null,
    referenceAttempts: 0, nextReferenceAttemptAt: null, referenceExpiresAt: null,
  };
}
export function transactionFromRow(row: TransactionRow): TransactionRecord {
  const transaction = WagerTransaction.rehydrate({
    id: row.id, walletId: row.walletId, playerId: row.playerId, kind: row.kind, status: row.status,
    money: Money.rehydrate(row.amountMinor,row.currency), createdAt: row.createdAt,
    ...(row.providerId===null ? {} : { providerId: row.providerId }),
    ...(row.externalTransactionId===null ? {} : { externalTransactionId: row.externalTransactionId }),
    ...(row.idempotencyKey===null ? {} : { idempotencyKey: row.idempotencyKey }),
    ...(row.payloadHash===null ? {} : { payloadHash: row.payloadHash }),
    ...(row.roundId===null ? {} : { roundId: row.roundId }), ...(row.gameId===null ? {} : { gameId: row.gameId }),
    ...(row.referenceExternalTransactionId===null ? {} : { referenceExternalTransactionId: row.referenceExternalTransactionId }),
    ...(row.referenceTransactionId===null ? {} : { referenceTransactionId: row.referenceTransactionId }),
    ...(row.failureCode===null ? {} : { failureCode: row.failureCode }), ...(row.processedAt===null ? {} : { processedAt: row.processedAt }),
    ...(row.completedAt===null ? {} : { completedAt: row.completedAt }),
  });
  return { transaction, firstResult: row.firstHttpStatus!==null && row.firstResponse!==null
    ? { status: row.firstHttpStatus, body: row.firstResponse as TransactionResult } : undefined,
    terminalResult: row.terminalResponse===null ? undefined : row.terminalResponse as unknown as RecordedResult,
    referenceAttempts: row.referenceAttempts, nextReferenceAttemptAt: row.nextReferenceAttemptAt===null ? undefined : new Date(row.nextReferenceAttemptAt),
    referenceExpiresAt: row.referenceExpiresAt===null ? undefined : new Date(row.referenceExpiresAt),
  };
}
export function ledgerToRow(entry: WalletLedgerEntry): LedgerRow {
  return { id: entry.id, walletId: entry.walletId, transactionId: entry.transactionId, walletVersion: entry.walletVersion,
    direction: entry.direction, amountMinor: entry.money.minorUnits, currency: entry.money.currency,
    balanceBeforeMinor: entry.balanceBefore.minorUnits, balanceAfterMinor: entry.balanceAfter.minorUnits, createdAt: entry.createdAt };
}
export function ledgerFromRow(row: LedgerRow): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({ ...row, money: Money.rehydrate(row.amountMinor,row.currency),
    balanceBefore: Money.rehydrate(row.balanceBeforeMinor,row.currency), balanceAfter: Money.rehydrate(row.balanceAfterMinor,row.currency) });
}
