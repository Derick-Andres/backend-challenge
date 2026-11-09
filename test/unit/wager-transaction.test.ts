import { describe, expect, test } from 'bun:test';
import { DomainValidationError, FailureCode, IdempotencyConflictError, InvalidTransactionStateError } from '../../src/domain/errors.js';
import { WagerTransaction, WagerTransactionKind as Kind, WagerTransactionStatus as Status } from '../../src/domain/wager-transaction.js';
import type { CreateWagerTransactionProps } from '../../src/domain/wager-transaction.js';
import { LedgerDirection } from '../../src/domain/wallet-ledger-entry.js';
import { at, expectCode, money, processed, reversal, tx, txProps, txState } from './domain-fixtures.js';

describe('WagerTransaction: factories e restauração', () => {
  test('create nasce PENDING e copia datas sem aceitar estado terminal injetado', () => {
    const props = { ...txProps(), status: Status.Processed, processedAt: at(1000), failureCode: FailureCode.InsufficientFunds };
    const result = WagerTransaction.create(props);
    props.createdAt.setUTCFullYear(2000);
    result.createdAt.setUTCFullYear(2001);
    expect(result.status).toBe(Status.Pending);
    expect(result.processedAt).toBeUndefined();
    expect(result.failureCode).toBeUndefined();
    expect(result.createdAt).toEqual(at());
    expect(Object.isFrozen(result)).toBe(true);
  });
  test('OPENING interno sem identidade externa; API da factory externa o rejeita', () => {
    const opening = WagerTransaction.opening({ id: 'opening', walletId: 'wallet', playerId: 'player', money: money(), createdAt: at() });
    expect(opening.providerId).toBeUndefined();
    expect(opening.payloadHash).toBeUndefined();
    expect(opening.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(() => tx({ kind: Kind.Opening as CreateWagerTransactionProps['kind'] })).toThrow(DomainValidationError);
    expectCode(() => WagerTransaction.opening({ id: 'o', walletId: 'w', playerId: 'p', money: money('0.00'), createdAt: at() }), FailureCode.AmountMustBePositive);
  });
  test.each([Kind.Refund, Kind.Rollback])('%s exige referência na factory', (kind) => {
    expectCode(() => tx({ kind }), FailureCode.ReferenceRequired);
  });
  test.each([Kind.Bet, Kind.Loss])('%s não aceita referência', (kind) => {
    expectCode(() => tx({ kind, referenceExternalTransactionId: 'ref' }), FailureCode.ReferenceNotAllowed);
  });
  test.each(['id', 'providerId', 'externalTransactionId', 'idempotencyKey', 'payloadHash', 'walletId', 'playerId', 'roundId', 'gameId'] as const)('%s obrigatório', (key) => {
    expect(() => tx({ [key]: '' })).toThrow(DomainValidationError);
  });
  test('Money negativo, datas inválidas e kind desconhecido não criam comando', () => {
    expect(() => tx({ money: money().negate() })).toThrow(DomainValidationError);
    expect(() => tx({ createdAt: new Date(NaN) })).toThrow(DomainValidationError);
    expect(() => tx({ kind: 'TRANSFER' as Kind.Bet })).toThrow(DomainValidationError);
    expect(() => tx({ money: { amount: '1.00', currency: 'BRL' } as never })).toThrow(DomainValidationError);
  });
  test.each([Status.Pending, Status.PendingReference, Status.Processed, Status.Rejected, Status.Failed])('rehydrate preserva %s e metadados sem executar transições', (status) => {
    const state = txState({ status, processedAt: at(1000), completedAt: at(2000), referenceTransactionId: 'saved-reference', failureCode: FailureCode.ReferenceNotFound });
    const result = WagerTransaction.rehydrate(state);
    state.processedAt?.setUTCFullYear(2000);
    result.completedAt?.setUTCFullYear(2000);
    expect(result.status).toBe(status);
    expect(result.referenceTransactionId).toBe('saved-reference');
    expect(result.failureCode).toBe(FailureCode.ReferenceNotFound);
    expect(result.processedAt).toEqual(at(1000));
    expect(result.completedAt).toEqual(at(2000));
  });
  test('hash igual é aceito; divergente é conflito de domínio, sem transição', () => {
    const result = tx();
    expect(result.matchesPayload('hash')).toBe(true);
    result.assertMatchesPayload('hash');
    expect(() => result.assertMatchesPayload('changed')).toThrow(IdempotencyConflictError);
    expect(result.status).toBe(Status.Pending);
  });
});

describe('transições', () => {
  test('PENDING -> PENDING_REFERENCE -> PROCESSED resolve a mesma identidade', () => {
    const result = reversal();
    result.markPendingReference();
    expect(result.status).toBe(Status.PendingReference);
    expect(() => result.markPendingReference()).toThrow(InvalidTransactionStateError);
    result.markProcessed(processed(), at(2000));
    expect(result.status).toBe(Status.Processed);
    expect(result.referenceTransactionId).toBe('reference');
    expect(result.processedAt).toEqual(at(2000));
    expect(result.completedAt).toEqual(at(2000));
    result.processedAt?.setUTCFullYear(2000);
    expect(result.processedAt).toEqual(at(2000));
  });
  test.each([Status.Pending, Status.PendingReference])('%s pode ser rejeitada ou falhar', (status) => {
    const rejected = WagerTransaction.rehydrate(txState({ status }));
    rejected.reject(FailureCode.InsufficientFunds, at(1000));
    expect(rejected.status).toBe(Status.Rejected);
    expect(rejected.processedAt).toBeUndefined();
    expect(rejected.completedAt).toEqual(at(1000));
    expect(rejected.affectsBalance()).toBe(false);
    const failed = WagerTransaction.rehydrate(txState({ status }));
    failed.fail(FailureCode.PermanentProcessingFailure, at(2000));
    expect(failed.status).toBe(Status.Failed);
    expect(failed.failureCode).toBe(FailureCode.PermanentProcessingFailure);
    expect(failed.affectsBalance()).toBe(false);
  });
  test.each([Status.Processed, Status.Rejected, Status.Failed])('terminal %s bloqueia todas as transições', (status) => {
    const result = WagerTransaction.rehydrate(txState({ status }));
    for (const action of [
      () => result.markProcessed(undefined, at()), () => result.markPendingReference(),
      () => result.reject(FailureCode.InsufficientFunds, at()), () => result.fail(FailureCode.PermanentProcessingFailure, at()),
    ]) expect(action).toThrow(InvalidTransactionStateError);
    expect(result.status).toBe(status);
  });
  test('transições validam data/código antes de modificar estado', () => {
    const result = tx();
    expect(() => result.markProcessed(undefined, new Date(NaN))).toThrow(DomainValidationError);
    expect(() => result.reject(FailureCode.InsufficientFunds, new Date(NaN))).toThrow(DomainValidationError);
    expect(() => result.fail(FailureCode.PermanentProcessingFailure, new Date(NaN))).toThrow(DomainValidationError);
    expect(() => result.reject(FailureCode.PermanentProcessingFailure as FailureCode.InsufficientFunds, at())).toThrow(DomainValidationError);
    expect(() => result.fail(FailureCode.InsufficientFunds as FailureCode.PermanentProcessingFailure, at())).toThrow(DomainValidationError);
    expect(() => result.markPendingReference()).toThrow(InvalidTransactionStateError);
    expect(result.status).toBe(Status.Pending);
  });
  test.each([Kind.Bet, Kind.Win, Kind.Refund, Kind.Rollback])('%s zero nasce pendente e recebe rejeição de negócio ao avaliar', (kind) => {
    const result = tx({ kind, money: money('0.00'), ...([Kind.Refund, Kind.Rollback].includes(kind) ? { referenceExternalTransactionId: 'ref-external' } : {}) });
    expect(result.status).toBe(Status.Pending);
    expectCode(() => result.markProcessed(undefined, at()), FailureCode.AmountMustBePositive);
  });
  test.each(['0.00', '99.00'])('LOSS %s pode ser processada sem efeito financeiro', (amount) => {
    const result = tx({ kind: Kind.Loss, money: money(amount) });
    result.markProcessed(undefined, at());
    expect(result.affectsBalance()).toBe(false);
    expect(result.ledgerDirectionFor()).toBeUndefined();
  });
});

describe('referências e reversões integrais', () => {
  test('ausente, pendente e terminal inválida têm códigos distintos', () => {
    expectCode(() => reversal().validateForProcessing(), FailureCode.ReferenceNotFound);
    const ref = tx({ id: 'reference', externalTransactionId: 'ref-external' });
    expectCode(() => reversal().validateForProcessing(ref), FailureCode.ReferenceNotReady);
    ref.reject(FailureCode.InsufficientFunds, at());
    expectCode(() => reversal().validateForProcessing(ref), FailureCode.ReferenceNotProcessed);
    const failed = WagerTransaction.rehydrate(txState({ id: 'reference', externalTransactionId: 'ref-external', status: Status.Failed }));
    expectCode(() => reversal().validateForProcessing(failed), FailureCode.ReferenceNotProcessed);
  });
  test.each(['providerId', 'walletId', 'playerId', 'roundId', 'externalTransactionId'] as const)('contexto exige %s igual', (key) => {
    expectCode(() => reversal().validateForProcessing(processed({ [key]: 'other' })), FailureCode.ReferenceContextMismatch);
  });
  test('gameId pode diferir e WIN opcional pode ter outro valor; não há settlement de rodada', () => {
    const reference = processed({ gameId: 'other-game' });
    reversal().validateForProcessing(reference);
    const win = tx({ kind: Kind.Win, money: money('200.00'), referenceExternalTransactionId: 'ref-external' });
    win.markProcessed(reference, at());
    expect(win.ledgerDirectionFor(reference)).toBe(LedgerDirection.Credit);
    tx({ kind: Kind.Win }).markProcessed(undefined, at());
  });
  test('moeda e valor da reversão devem coincidir; autorreferência proibida', () => {
    expectCode(() => reversal().validateForProcessing(processed({ money: money('10.00', 'USD') })), FailureCode.CurrencyMismatch);
    expectCode(() => reversal({ money: money('9.99') }).validateForProcessing(processed()), FailureCode.ReferenceAmountMismatch);
    expectCode(() => reversal({ externalTransactionId: 'ref-external' }).validateForProcessing(processed()), FailureCode.SelfReference);
    expectCode(() => reversal({ id: 'reference' }).validateForProcessing(processed()), FailureCode.SelfReference);
  });
  test.each([Kind.Opening, Kind.Loss, Kind.Rollback])('ROLLBACK não pode referenciar %s', (kind) => {
    const reference = WagerTransaction.rehydrate(txState({ id: 'reference', externalTransactionId: 'ref-external', kind, status: Status.Processed }));
    expectCode(() => reversal({ kind: Kind.Rollback }).validateForProcessing(reference), FailureCode.ReferenceKindInvalid);
  });
  test.each([Kind.Win, Kind.Refund])('REFUND e WIN referenciando %s são inválidos', (kind) => {
    const reference = WagerTransaction.rehydrate(txState({ id: 'reference', externalTransactionId: 'ref-external', kind, status: Status.Processed }));
    expectCode(() => reversal().validateForProcessing(reference), FailureCode.ReferenceKindInvalid);
    expectCode(() => tx({ kind: Kind.Win, referenceExternalTransactionId: 'ref-external' }).validateForProcessing(reference), FailureCode.ReferenceKindInvalid);
  });
  test('unicidade visível por referência + tipo; rejeitada não consome direito', () => {
    const reference = processed();
    const refund = reversal();
    refund.markProcessed(reference, at());
    expectCode(() => reversal({ id: 'another' }).validateForProcessing(reference, [refund]), FailureCode.AlreadyReversedByKind);
    reversal({ kind: Kind.Rollback }).validateForProcessing(reference, [refund]);
    const rejected = reversal();
    rejected.reject(FailureCode.ReferenceNotReady, at());
    reversal().validateForProcessing(reference, [rejected]);
  });
});
