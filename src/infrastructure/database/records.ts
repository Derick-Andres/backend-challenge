import { EntitySchema, Type } from '@mikro-orm/core';
import { minorUnitsFromDatabase, minorUnitsToDatabase } from './money-converter.js';
import type { WagerTransactionKind, WagerTransactionStatus } from '../../domain/wager-transaction.js';
import type { FailureCode } from '../../domain/errors.js';
import type { LedgerDirection } from '../../domain/wallet-ledger-entry.js';

export class ExactBigIntType extends Type<bigint, string> {
  override convertToDatabaseValue(value: bigint): string { return minorUnitsToDatabase(value); }
  override convertToJSValue(value: unknown): bigint { return minorUnitsFromDatabase(value); }
  override getColumnType(): string { return 'bigint'; }
  override compareAsType(): string { return 'bigint'; }
}

export interface WalletRow { id: string; playerId: string; currency: string; balanceMinor: bigint; version: number; createdAt: Date; updatedAt: Date }
export const walletSchema = new EntitySchema<WalletRow>({ name: 'WalletRow', tableName: 'wallets', properties: {
  id: { type: 'text', primary: true }, playerId: { type: 'text' }, currency: { type: 'text' },
  balanceMinor: { type: ExactBigIntType }, version: { type: 'integer' }, createdAt: { type: Date }, updatedAt: { type: Date },
} });

export interface TransactionRow {
  id: string; providerId: string | null; externalTransactionId: string | null; idempotencyKey: string | null; payloadHash: string | null;
  walletId: string; playerId: string; roundId: string | null; gameId: string | null; kind: WagerTransactionKind;
  amountMinor: bigint; currency: string; referenceExternalTransactionId: string | null; referenceTransactionId: string | null;
  status: WagerTransactionStatus; failureCode: FailureCode | null; createdAt: Date; processedAt: Date | null; completedAt: Date | null;
  firstHttpStatus: number | null; firstResponse: Record<string, unknown> | null; terminalResponse: Record<string, unknown> | null;
  referenceAttempts: number; nextReferenceAttemptAt: Date | null; referenceExpiresAt: Date | null;
}
const optionalText = { type: 'text', nullable: true } as const;
const optionalDate = { type: Date, nullable: true } as const;
export const transactionSchema = new EntitySchema<TransactionRow>({ name: 'TransactionRow', tableName: 'wager_transactions', properties: {
  id: { type: 'text', primary: true }, providerId: optionalText, externalTransactionId: optionalText, idempotencyKey: optionalText, payloadHash: optionalText,
  walletId: { type: 'text' }, playerId: { type: 'text' }, roundId: optionalText, gameId: optionalText, kind: { type: 'text' },
  amountMinor: { type: ExactBigIntType }, currency: { type: 'text' }, referenceExternalTransactionId: optionalText, referenceTransactionId: optionalText,
  status: { type: 'text' }, failureCode: optionalText, createdAt: { type: Date }, processedAt: optionalDate, completedAt: optionalDate,
  firstHttpStatus: { type: 'integer', nullable: true }, firstResponse: { type: 'json', nullable: true }, terminalResponse: { type: 'json', nullable: true },
  referenceAttempts: { type: 'integer' }, nextReferenceAttemptAt: optionalDate, referenceExpiresAt: optionalDate,
} });

export interface LedgerRow {
  id: string; walletId: string; transactionId: string; walletVersion: number; direction: LedgerDirection;
  amountMinor: bigint; currency: string; balanceBeforeMinor: bigint; balanceAfterMinor: bigint; createdAt: Date;
}
export const ledgerSchema = new EntitySchema<LedgerRow>({ name: 'LedgerRow', tableName: 'wallet_ledger_entries', properties: {
  id: { type: 'text', primary: true }, walletId: { type: 'text' }, transactionId: { type: 'text' }, walletVersion: { type: 'integer' }, direction: { type: 'text' },
  amountMinor: { type: ExactBigIntType }, currency: { type: 'text' }, balanceBeforeMinor: { type: ExactBigIntType }, balanceAfterMinor: { type: ExactBigIntType }, createdAt: { type: Date },
} });

export interface OutboxRow {
  id: string; aggregateId: string; eventType: string; payload: Readonly<Record<string, unknown>>; occurredAt: Date;
  attempts: number; nextAttemptAt: Date; publishedAt: Date | null;
}
export const outboxSchema = new EntitySchema<OutboxRow>({ name: 'OutboxRow', tableName: 'outbox_messages', properties: {
  id: { type: 'text', primary: true }, aggregateId: { type: 'text' }, eventType: { type: 'text' }, payload: { type: 'json' }, occurredAt: { type: Date },
  attempts: { type: 'integer' }, nextAttemptAt: { type: Date }, publishedAt: optionalDate,
} });

export interface InboxRow { consumerName: string; messageId: string; payloadHash: string; receivedAt: Date; processedAt: Date | null; disposition: 'ACK' | 'DLQ' | null }
export const inboxSchema = new EntitySchema<InboxRow>({ name: 'InboxRow',tableName: 'inbox_messages',properties: {
  consumerName: { type: 'text',primary: true },messageId: { type: 'text',primary: true },payloadHash: { type: 'text' },
  receivedAt: { type: Date },processedAt: optionalDate,disposition: optionalText,
} });
