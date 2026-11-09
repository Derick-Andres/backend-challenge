import { describe, expect, test } from 'bun:test';
import { backoffDelay } from '../../src/domain/backoff.js';
import { DomainValidationError, IdempotencyConflictError, InvalidMessageStateError } from '../../src/domain/errors.js';
import { InboxMessage } from '../../src/domain/inbox-message.js';
import { WagerTransactionProcessed } from '../../src/domain/integration-events.js';
import { OutboxMessage } from '../../src/domain/outbox-message.js';
import { at, processed } from './domain-fixtures.js';

const enqueue = (): OutboxMessage => OutboxMessage.enqueue(WagerTransactionProcessed.from(processed(), {
  eventId: 'event', correlationId: 'correlation', occurredAt: at(),
}));

describe('InboxMessage', () => {
  test('receive copia identidade/data e ignora conclusão injetada', () => {
    const props = { messageId: 'message', consumerName: 'consumer', payloadHash: 'hash', receivedAt: at(), processedAt: at(1000) };
    const inbox = InboxMessage.receive(props);
    props.receivedAt.setUTCFullYear(2000);
    inbox.receivedAt.setUTCFullYear(2000);
    expect(inbox.messageId).toBe('message');
    expect(inbox.consumerName).toBe('consumer');
    expect(inbox.receivedAt).toEqual(at());
    expect(inbox.isProcessed()).toBe(false);
    expect(inbox.matchesPayload('hash')).toBe(true);
    inbox.assertMatchesPayload('hash');
    expect(() => inbox.assertMatchesPayload('other')).toThrow(IdempotencyConflictError);
    expect(Object.isFrozen(inbox)).toBe(true);
  });
  test('conclui uma vez; datas inválidas não alteram estado', () => {
    const inbox = InboxMessage.receive({ messageId: 'm', consumerName: 'c', payloadHash: 'h', receivedAt: at() });
    expect(() => inbox.markProcessed(new Date(NaN))).toThrow(DomainValidationError);
    expect(inbox.isProcessed()).toBe(false);
    const completion = at(1000);
    inbox.markProcessed(completion);
    completion.setUTCFullYear(2000);
    inbox.processedAt?.setUTCFullYear(2000);
    expect(inbox.processedAt).toEqual(at(1000));
    expect(() => inbox.markProcessed(at(2000))).toThrow(InvalidMessageStateError);
  });
  test('rehydrate restaura conclusão original; não chama markProcessed', () => {
    const state = { messageId: 'm', consumerName: 'c', payloadHash: 'h', receivedAt: at(), processedAt: at(1000) };
    const inbox = InboxMessage.rehydrate(state);
    state.processedAt.setUTCFullYear(2000);
    expect(inbox.isProcessed()).toBe(true);
    expect(inbox.processedAt).toEqual(at(1000));
    expect(() => inbox.markProcessed(at())).toThrow(InvalidMessageStateError);
    expect(() => InboxMessage.receive({ ...state, payloadHash: '' })).toThrow(DomainValidationError);
  });
});

describe('OutboxMessage e backoff', () => {
  test('enqueue guarda envelope JSON imutável e eventId estável, inicialmente vencido', () => {
    const message = enqueue();
    expect(message.id).toBe('event');
    expect(message.aggregateId).toBe('reference');
    expect(message.eventType).toBe('WagerTransactionProcessed');
    expect(message.payload['eventId']).toBe(message.id);
    expect(message.attempts).toBe(0);
    expect(message.isPending()).toBe(true);
    expect(message.isDue(at())).toBe(true);
    expect(message.nextAttemptAt).toBeUndefined();
    expect(Object.isFrozen(message.payload)).toBe(true);
    expect(Reflect.set(message.payload, 'eventId', 'changed')).toBe(false);
    expect(Object.isFrozen(message)).toBe(true);
  });
  test('backoff determinístico cresce, aplica equal jitter e limita janela a 60s', () => {
    const policy = { baseDelayMs: 1000, maxDelayMs: 60_000 };
    expect(backoffDelay(1, () => 0, policy)).toBe(500);
    expect(backoffDelay(1, () => 0.5, policy)).toBe(750);
    expect(backoffDelay(2, () => 0.5, policy)).toBe(1500);
    expect(backoffDelay(100, () => 0, policy)).toBe(30_000);
    expect(backoffDelay(Number.MAX_SAFE_INTEGER, () => 0.999, policy)).toBe(59_970);
    expect(backoffDelay(100, () => 1 - Number.EPSILON, policy)).toBe(59_999);
  });
  test('scheduleRetry usa relógio e amostra recebidos, não espera; isDue inclui limite exato', () => {
    const message = enqueue();
    message.scheduleRetry(at(1000), () => 0);
    expect(message.attempts).toBe(1);
    expect(message.nextAttemptAt).toEqual(at(1500));
    expect(message.isDue(at(1499))).toBe(false);
    expect(message.isDue(at(1500))).toBe(true);
    message.nextAttemptAt?.setUTCFullYear(2000);
    expect(message.nextAttemptAt).toEqual(at(1500));
    message.scheduleRetry(at(2000), () => 0.5);
    expect(message.attempts).toBe(2);
    expect(message.nextAttemptAt).toEqual(at(3500));
    expect(message.id).toBe('event');
    expect(message.payload['eventId']).toBe('event');
  });
  test.each([NaN, Infinity, -0.1, 1])('amostra inválida %p não consome tentativa', (sample) => {
    const message = enqueue();
    expect(() => message.scheduleRetry(at(), () => sample)).toThrow(DomainValidationError);
    expect(message.attempts).toBe(0);
    expect(message.nextAttemptAt).toBeUndefined();
  });
  test('política inválida, contador inválido, data inválida e overflow de data são rejeitados', () => {
    expect(() => backoffDelay(0, () => 0, { baseDelayMs: 1, maxDelayMs: 10 })).toThrow(DomainValidationError);
    expect(() => backoffDelay(1, () => 0, { baseDelayMs: 10, maxDelayMs: 5 })).toThrow(DomainValidationError);
    expect(() => backoffDelay(1, () => 0, { baseDelayMs: 0, maxDelayMs: 5 })).toThrow(DomainValidationError);
    const message = enqueue();
    expect(() => message.scheduleRetry(new Date(NaN), () => 0)).toThrow(DomainValidationError);
    expect(() => message.scheduleRetry(new Date(8_640_000_000_000_000), () => 0)).toThrow(DomainValidationError);
    expect(message.attempts).toBe(0);
    expect(message.nextAttemptAt).toBeUndefined();
  });
  test('publicação conclui uma vez, não é elegível e não admite novos retries', () => {
    const message = enqueue();
    expect(() => message.markPublished(new Date(NaN))).toThrow(DomainValidationError);
    expect(message.isPending()).toBe(true);
    const published = at(2000);
    message.markPublished(published);
    published.setUTCFullYear(2000);
    message.publishedAt?.setUTCFullYear(2000);
    expect(message.publishedAt).toEqual(at(2000));
    expect(message.isDue(at(10_000))).toBe(false);
    expect(() => message.markPublished(at())).toThrow(InvalidMessageStateError);
    expect(() => message.scheduleRetry(at(), () => 0)).toThrow(InvalidMessageStateError);
  });
  test('rehydrate preserva envelope/tentativas/agendamento sem enqueue/retry ou nova identidade', () => {
    const payload = { eventId: 'saved', data: { money: { amount: '10.00', currency: 'BRL' } } };
    const state = { id: 'saved', aggregateId: 'aggregate', eventType: 'SavedEvent', payload, occurredAt: at(), attempts: 9, nextAttemptAt: at(5000) };
    const restored = OutboxMessage.rehydrate(state);
    payload.data.money.amount = '999.00';
    state.occurredAt.setUTCFullYear(2000);
    state.nextAttemptAt.setUTCFullYear(2000);
    restored.occurredAt.setUTCFullYear(2000);
    expect(restored.attempts).toBe(9);
    expect(restored.id).toBe('saved');
    expect(restored.payload['data']).toEqual({ money: { amount: '10.00', currency: 'BRL' } });
    expect(restored.nextAttemptAt).toEqual(at(5000));
    expect(restored.occurredAt).toEqual(at());
    const published = OutboxMessage.rehydrate({ ...state, publishedAt: at(7000) });
    expect(published.isPending()).toBe(false);
    expect(published.publishedAt).toEqual(at(7000));
    expect(published.attempts).toBe(9);
    expect(() => OutboxMessage.rehydrate({ ...state, attempts: -1 })).toThrow(DomainValidationError);
  });
});
