import { describe, expect, test } from 'bun:test';
import { DomainValidationError, FailureCode } from '../../src/domain/errors.js';
import { IntegrationEvent } from '../../src/domain/integration-event.js';
import type { IntegrationEventProps } from '../../src/domain/integration-event.js';
import { WalletBalanceChanged, WagerTransactionPendingReference, WagerTransactionProcessed, WagerTransactionRejected } from '../../src/domain/integration-events.js';
import { WagerTransactionKind as Kind, WagerTransactionStatus as Status } from '../../src/domain/wager-transaction.js';
import { LedgerDirection } from '../../src/domain/wallet-ledger-entry.js';
import { at, money, reversal, tx, wallet } from './domain-fixtures.js';

const context = () => ({ eventId: 'event', correlationId: 'correlation', causationId: 'command', occurredAt: at(1000) });

// Exercita também payloads aninhados da classe abstrata sem criar um barramento.
class TestEvent extends IntegrationEvent<{ nested: { items: { value: string }[] } }> {
  readonly eventType = 'TestEvent';
  readonly version = 1;
  private constructor(props: IntegrationEventProps<{ nested: { items: { value: string }[] } }>) { super(props); Object.freeze(this); }
  static create(data = { nested: { items: [{ value: 'original' }] } }): TestEvent {
    return new TestEvent({ ...context(), aggregateId: 'aggregate', data });
  }
}

describe('eventos de integração', () => {
  test('PROCESSED inclusive LOSS e OPENING: tipo/version da subclasse e MoneyProps serializáveis', () => {
    const loss = tx({ kind: Kind.Loss, money: money('123.45') });
    loss.markProcessed(undefined, at(500));
    const event = WagerTransactionProcessed.from(loss, context());
    expect(event).toBeInstanceOf(IntegrationEvent);
    expect(event.eventType).toBe('WagerTransactionProcessed');
    expect(event.version).toBe(1);
    expect(event.aggregateId).toBe(loss.id);
    expect(event.data.money).toEqual({ amount: '123.45', currency: 'BRL' });
    expect(event.data.processedAt).toBe(at(500).toISOString());
    expect(JSON.parse(JSON.stringify(event)).data.money).toEqual(event.data.money);
    const opening = wallet().openingTransaction;
    if (!opening) throw new Error('Fixture exige OPENING');
    const openingEvent = WagerTransactionProcessed.from(opening, context());
    expect(openingEvent.data.kind).toBe(Kind.Opening);
    expect(Object.hasOwn(openingEvent.data, 'providerId')).toBe(false);
  });
  test('REJECTED carrega failureCode estável e não instancia evento de processada', () => {
    const transaction = tx();
    transaction.reject(FailureCode.InsufficientFunds, at());
    const event = WagerTransactionRejected.from(transaction, context());
    expect(event.eventType).toBe('WagerTransactionRejected');
    expect(event.version).toBe(1);
    expect(event.data.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(event.data.status).toBe(Status.Rejected);
    expect(() => WagerTransactionProcessed.from(transaction, context())).toThrow(DomainValidationError);
  });
  test('PENDING_REFERENCE é snapshot; conclusão posterior não modifica payload', () => {
    const transaction = reversal();
    transaction.markPendingReference();
    const event = WagerTransactionPendingReference.from(transaction, context());
    transaction.reject(FailureCode.ReferenceNotFound, at(2000));
    expect(event.eventType).toBe('WagerTransactionPendingReference');
    expect(event.version).toBe(1);
    expect(event.data.referenceExternalTransactionId).toBe('ref-external');
    expect(event.data.status).toBe(Status.PendingReference);
    expect(() => WagerTransactionPendingReference.from(transaction, context())).toThrow(DomainValidationError);
  });
  test('factories recusam eventos incompatíveis com o estado', () => {
    expect(() => WagerTransactionProcessed.from(tx(), context())).toThrow(DomainValidationError);
    expect(() => WagerTransactionRejected.from(tx(), context())).toThrow(DomainValidationError);
    expect(() => WagerTransactionPendingReference.from(reversal(), context())).toThrow(DomainValidationError);
  });
  test('WalletBalanceChanged usa saldos/direção/versão do ledger e permanece histórico', () => {
    const aggregate = wallet();
    const entry = aggregate.apply(tx(), { entryId: 'bet', at: at(1000) });
    if (!entry) throw new Error('Fixture exige ledger');
    const event = WalletBalanceChanged.from(aggregate, entry, context());
    expect(event.eventType).toBe('WalletBalanceChanged');
    expect(event.version).toBe(1);
    expect(event.aggregateId).toBe(aggregate.id);
    expect(event.data).toEqual({
      walletId: 'wallet', transactionId: 'tx', direction: LedgerDirection.Debit, money: { amount: '10.00', currency: 'BRL' },
      balanceBefore: { amount: '100.00', currency: 'BRL' }, balanceAfter: { amount: '90.00', currency: 'BRL' }, walletVersion: 2,
    });
    aggregate.apply(tx({ id: 'win', kind: Kind.Win }), { entryId: 'win', at: at(2000) });
    expect(event.data.balanceAfter.amount).toBe('90.00');
    expect(event.data.walletVersion).toBe(2);
    expect(() => WalletBalanceChanged.from(aggregate, entry, context())).toThrow(DomainValidationError);
    expect(() => WalletBalanceChanged.from(wallet('0.00'), entry, context())).toThrow(DomainValidationError);
  });
  test('envelope não compartilha data mutável nem expõe campos opcionais undefined', () => {
    const transaction = tx();
    transaction.markProcessed(undefined, at());
    const ctx = { eventId: 'event', correlationId: 'correlation', occurredAt: at(1000) };
    const event = WagerTransactionProcessed.from(transaction, ctx);
    ctx.occurredAt.setUTCFullYear(2000);
    event.occurredAt.setUTCFullYear(2000);
    const envelope = event.toJSON();
    expect(envelope.occurredAt).toBe(at(1000).toISOString());
    expect(Object.hasOwn(envelope, 'causationId')).toBe(false);
    expect(envelope.eventId).toBe('event');
    expect(envelope.aggregateId).toBe(transaction.id);
    expect(Object.isFrozen(envelope)).toBe(true);
    expect(Reflect.set(event.data.money, 'amount', '999.00')).toBe(false);
    expect(Reflect.set(event, 'eventType', 'other')).toBe(false);
    expect(Reflect.set(envelope, 'version', 999)).toBe(false);
    expect(event.toJSON().data.money.amount).toBe('10.00');
    expect(WagerTransactionProcessed.from(transaction, context()).toJSON().causationId).toBe('command');
    expect(() => WagerTransactionProcessed.from(transaction, { ...context(), eventId: '' })).toThrow(DomainValidationError);
    expect(() => WagerTransactionProcessed.from(transaction, { ...context(), occurredAt: new Date(NaN) })).toThrow(DomainValidationError);
  });
  test('copia e congela recursivamente objetos/arrays na entrada e saída', () => {
    const input = { nested: { items: [{ value: 'original' }] } };
    const event = TestEvent.create(input);
    input.nested.items[0]!.value = 'changed';
    input.nested.items.push({ value: 'added' });
    expect(event.data.nested.items).toEqual([{ value: 'original' }]);
    expect(Object.isFrozen(event.data.nested.items)).toBe(true);
    expect(Reflect.set(event.data.nested.items[0]!, 'value', 'mutated')).toBe(false);
    expect(() => (event.toJSON().data.nested.items as { value: string }[]).push({ value: 'mutated' })).toThrow();
  });
  test.each([money(), at(), 1n, undefined, Infinity, NaN, () => undefined])('payload recusa valor não JSON: %p', (value) => {
    expect(() => TestEvent.create({ nested: { items: [{ value: value as unknown as string }] } })).toThrow(DomainValidationError);
  });
  test('ciclo em payload é inválido', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(() => TestEvent.create(cyclic as never)).toThrow(DomainValidationError);
  });
});
