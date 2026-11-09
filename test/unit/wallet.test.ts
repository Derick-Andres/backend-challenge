import { describe, expect, test } from 'bun:test';
import { DomainValidationError, FailureCode, InvalidTransactionStateError } from '../../src/domain/errors.js';
import { WagerTransaction, WagerTransactionKind as Kind, WagerTransactionStatus as Status } from '../../src/domain/wager-transaction.js';
import { Wallet } from '../../src/domain/wallet.js';
import { LedgerDirection as Direction, WalletLedgerEntry } from '../../src/domain/wallet-ledger-entry.js';
import type { LedgerEntryState } from '../../src/domain/wallet-ledger-entry.js';
import { at, expectCode, money, processed, reversal, tx, txState, wallet } from './domain-fixtures.js';

describe('Wallet', () => {
  test('abertura zero não gera transação nem ledger; version inicia em 1', () => {
    const result = wallet('0.00');
    expect(result.balance.isZero()).toBe(true);
    expect(result.version).toBe(1);
    expect(result.ledgerEntries).toEqual([]);
    expect(result.openingTransaction).toBeUndefined();
  });
  test('abertura positiva retém OPENING + CREDIT coerentes em version 1', () => {
    const result = wallet();
    const entry = result.ledgerEntries[0];
    expect(result.balance.toString()).toBe('100.00 BRL');
    expect(result.version).toBe(1);
    expect(entry?.balanceBefore.isZero()).toBe(true);
    expect(entry?.balanceAfter.equals(result.balance)).toBe(true);
    expect(entry?.walletVersion).toBe(1);
    expect(entry?.direction).toBe(Direction.Credit);
    expect(entry?.isBalanced()).toBe(true);
    expect(result.openingTransaction?.status).toBe(Status.Processed);
    expect(result.openingTransaction?.kind).toBe(Kind.Opening);
    expect(result.openingTransaction?.id).toBe(entry?.transactionId);
    expect(result.openingTransaction?.externalTransactionId).toBeUndefined();
  });
  test('abertura exige saldo não negativo, data, ids e identidades de auditoria quando positiva', () => {
    const props = { id: 'wallet', playerId: 'player', initialBalance: money(), createdAt: at() };
    expect(() => Wallet.open(props)).toThrow(DomainValidationError);
    expect(() => Wallet.open({ ...props, initialBalance: money().negate() })).toThrow(DomainValidationError);
    expect(() => Wallet.open({ ...props, initialBalance: money('0.00'), id: '' })).toThrow(DomainValidationError);
    expect(() => Wallet.open({ ...props, initialBalance: money('0.00'), createdAt: new Date(NaN) })).toThrow(DomainValidationError);
  });
  test('rehydrate restaura saldo/version/datas sem abertura nem lançamentos novos', () => {
    const state = { id: 'wallet', playerId: 'player', currency: 'BRL', balance: money('65.00'), version: 7, createdAt: at(), updatedAt: at(3000) };
    const result = Wallet.rehydrate(state);
    state.updatedAt.setUTCFullYear(2000);
    result.createdAt.setUTCFullYear(2000);
    result.updatedAt.setUTCFullYear(2000);
    expect(result.balance.toString()).toBe('65.00 BRL');
    expect(result.version).toBe(7);
    expect(result.updatedAt).toEqual(at(3000));
    expect(result.createdAt).toEqual(at());
    expect(result.ledgerEntries).toEqual([]);
    expect(result.openingTransaction).toBeUndefined();
    expect(Object.isFrozen(result)).toBe(true);
    expect(Reflect.set(result, 'balance', money('999.00'))).toBe(false);
  });
  test('saldo/currency/version inválidos não são representáveis nem na reidratação', () => {
    const state = { id: 'wallet', playerId: 'player', currency: 'BRL', balance: money(), version: 1, createdAt: at(), updatedAt: at() };
    expect(() => Wallet.rehydrate({ ...state, balance: money().negate() })).toThrow(DomainValidationError);
    expectCode(() => Wallet.rehydrate({ ...state, currency: 'USD' }), FailureCode.CurrencyMismatch);
    for (const version of [0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => Wallet.rehydrate({ ...state, version })).toThrow(DomainValidationError);
    }
  });
  test('BET e WIN aplicam saldo/version/estado e preservam ledger mesmo ignorando retorno', () => {
    const result = wallet();
    const bet = tx();
    result.apply(bet, { entryId: 'bet-entry', at: at(1000) });
    const snapshot = result.ledgerEntries;
    const win = tx({ id: 'win', externalTransactionId: 'win', kind: Kind.Win, money: money('25.00') });
    const credit = result.apply(win, { entryId: 'win-entry', at: at(2000) });
    expect(bet.status).toBe(Status.Processed);
    expect(win.status).toBe(Status.Processed);
    expect(result.balance.toString()).toBe('115.00 BRL');
    expect(result.version).toBe(3);
    expect(result.updatedAt).toEqual(at(2000));
    expect(snapshot).toHaveLength(2);
    expect(result.ledgerEntries).toHaveLength(3);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(() => (snapshot as WalletLedgerEntry[]).pop()).toThrow();
    expect(result.ledgerEntries[1]?.direction).toBe(Direction.Debit);
    expect(result.ledgerEntries[1]?.balanceBefore.toString()).toBe('100.00 BRL');
    expect(result.ledgerEntries[1]?.balanceAfter.toString()).toBe('90.00 BRL');
    expect(credit?.balanceBefore.toString()).toBe('90.00 BRL');
    expect(credit?.balanceAfter.equals(result.balance)).toBe(true);
    expect(credit?.walletVersion).toBe(result.version);
    const reconstructed = result.ledgerEntries.reduce((sum, entry) => entry.direction === Direction.Credit ? sum.add(entry.money) : sum.subtract(entry.money), money('0.00'));
    expect(reconstructed.equals(result.balance)).toBe(true);
  });
  test.each(['0.00', '10.00'])('LOSS de %s não muda saldo, version, updatedAt ou ledger', (amount) => {
    const result = wallet();
    const loss = tx({ kind: Kind.Loss, money: money(amount) });
    expect(result.apply(loss, { at: at(1000) })).toBeUndefined();
    expect(loss.status).toBe(Status.Processed);
    expect(result.balance.toString()).toBe('100.00 BRL');
    expect(result.version).toBe(1);
    expect(result.updatedAt).toEqual(at());
    expect(result.ledgerEntries).toHaveLength(1);
  });
  test('insuficiência de BET não causa efeitos; rejeição é transição explícita e auditável', () => {
    const result = wallet('5.00');
    const bet = tx();
    expectCode(() => result.apply(bet, { entryId: 'entry', at: at(1000) }), FailureCode.InsufficientFunds);
    expect(bet.status).toBe(Status.Pending);
    bet.reject(FailureCode.InsufficientFunds, at(1000));
    expect(() => result.apply(bet, { entryId: 'entry', at: at(1000) })).toThrow(InvalidTransactionStateError);
    expect(result.balance.toString()).toBe('5.00 BRL');
    expect(result.version).toBe(1);
    expect(result.ledgerEntries).toHaveLength(1);
  });
  test.each([
    ['wallet', { walletId: 'other' }, FailureCode.WalletMismatch],
    ['player', { playerId: 'other' }, FailureCode.WalletPlayerMismatch],
    ['currency', { money: money('10.00', 'USD') }, FailureCode.CurrencyMismatch],
  ] as const)('protege %s antes de modificar saldo ou transação', (_name, overrides, code) => {
    const result = wallet();
    const transaction = tx(overrides);
    expectCode(() => result.apply(transaction, { entryId: 'entry', at: at() }), code);
    expect(transaction.status).toBe(Status.Pending);
    expect(result.version).toBe(1);
    expect(result.balance.toString()).toBe('100.00 BRL');
    expect(result.ledgerEntries).toHaveLength(1);
  });
  test('entryId ausente, data inválida e overflow de version não deixam movimento parcial', () => {
    const result = wallet();
    const transaction = tx();
    expect(() => result.apply(transaction, { at: at() })).toThrow(DomainValidationError);
    expect(() => result.apply(transaction, { entryId: 'entry', at: new Date(NaN) })).toThrow(DomainValidationError);
    expect(transaction.status).toBe(Status.Pending);
    expect(result.version).toBe(1);
    expect(result.ledgerEntries).toHaveLength(1);
    const maxVersion = Wallet.rehydrate({ id: 'wallet', playerId: 'player', currency: 'BRL', balance: money(), version: Number.MAX_SAFE_INTEGER, createdAt: at(), updatedAt: at() });
    expect(() => maxVersion.apply(transaction, { entryId: 'entry', at: at() })).toThrow(DomainValidationError);
    expect(maxVersion.balance.toString()).toBe('10.00 BRL');
    expect(transaction.status).toBe(Status.Pending);
  });
  test('BET pode consumir todo saldo; reaplicar terminal ou nova entidade com mesmo id não duplica movimento local', () => {
    const result = wallet('10.00');
    const bet = tx();
    result.apply(bet, { entryId: 'bet-entry', at: at() });
    expect(result.balance.isZero()).toBe(true);
    expect(() => result.apply(bet, { entryId: 'again', at: at() })).toThrow(InvalidTransactionStateError);
    expect(() => result.apply(tx(), { entryId: 'again', at: at() })).toThrow(DomainValidationError);
    expect(result.version).toBe(2);
  });
  test('OPENING não pode ser aplicado novamente como comando', () => {
    const opening = WagerTransaction.opening({ id: 'o', walletId: 'wallet', playerId: 'player', money: money(), createdAt: at() });
    expect(() => wallet().apply(opening, { entryId: 'e', at: at() })).toThrow(DomainValidationError);
  });
  test('saldo acima de MAX_SAFE_INTEGER continua exato no agregado e no ledger', () => {
    const result = wallet('90071992547409.93');
    const entry = result.apply(tx({ money: money('0.01') }), { entryId: 'entry', at: at() });
    expect(result.balance.minorUnits).toBe(9007199254740992n);
    expect(entry?.balanceBefore.minorUnits).toBe(9007199254740993n);
    expect(entry?.isBalanced()).toBe(true);
  });
});

describe('efeitos de reversões', () => {
  test('REFUND + ROLLBACK da mesma BET geram dois créditos, um de cada tipo', () => {
    const result = wallet();
    const bet = tx({ id: 'reference', externalTransactionId: 'ref-external' });
    result.apply(bet, { entryId: 'bet', at: at() });
    const refund = reversal({ id: 'refund' });
    result.apply(refund, { reference: bet, entryId: 'refund', at: at(1000) });
    const rollback = reversal({ id: 'rollback', kind: Kind.Rollback });
    result.apply(rollback, { reference: bet, entryId: 'rollback', at: at(2000) });
    expect(result.balance.toString()).toBe('110.00 BRL');
    expect(result.version).toBe(4);
    expect(result.ledgerEntries.slice(2).map((entry) => entry.direction)).toEqual([Direction.Credit, Direction.Credit]);
    expectCode(() => result.apply(reversal({ id: 'second-refund' }), { reference: bet, entryId: 'no', at: at() }), FailureCode.AlreadyReversedByKind);
    expectCode(() => result.apply(reversal({ id: 'second-rollback', kind: Kind.Rollback }), { reference: bet, entryId: 'no', at: at() }), FailureCode.AlreadyReversedByKind);
  });
  test.each([Kind.Win, Kind.Refund])('ROLLBACK de %s inverte crédito com DEBIT', (kind) => {
    const result = wallet();
    const reference = WagerTransaction.rehydrate(txState({ id: 'reference', externalTransactionId: 'ref-external', kind, status: Status.Processed }));
    const entry = result.apply(reversal({ kind: Kind.Rollback }), { reference, entryId: 'entry', at: at(1000) });
    expect(entry?.direction).toBe(Direction.Debit);
    expect(entry?.balanceAfter.toString()).toBe('90.00 BRL');
    expect(entry?.isBalanced()).toBe(true);
  });
  test('insuficiência de reversão usa código próprio e não produz ledger nem transição', () => {
    const result = wallet('0.00');
    const rollback = reversal({ kind: Kind.Rollback });
    expectCode(() => result.apply(rollback, { reference: processed({ kind: Kind.Win }), entryId: 'entry', at: at() }), FailureCode.ReversalInsufficientFunds);
    expect(result.balance.isZero()).toBe(true);
    expect(result.version).toBe(1);
    expect(result.ledgerEntries).toHaveLength(0);
    expect(rollback.status).toBe(Status.Pending);
  });
  test('reversão previamente carregada bloqueia outro processamento do mesmo tipo', () => {
    const reference = processed();
    const previous = reversal();
    previous.markProcessed(reference, at());
    expectCode(() => wallet().apply(reversal({ id: 'other' }), { reference, processedReversals: [previous], entryId: 'e', at: at() }), FailureCode.AlreadyReversedByKind);
  });
});

describe('WalletLedgerEntry', () => {
  const entryState = (overrides: Partial<LedgerEntryState> = {}): LedgerEntryState => ({
    id: 'e', walletId: 'w', transactionId: 't', walletVersion: 2, direction: Direction.Debit,
    money: money('25.00'), balanceBefore: money('100.00'), balanceAfter: money('75.00'), createdAt: at(), ...overrides,
  });
  test('valida débito/crédito e protege valores, datas e campos contra mutação', () => {
    const props = entryState();
    const debit = WalletLedgerEntry.create(props);
    const credit = WalletLedgerEntry.create(entryState({ direction: Direction.Credit, balanceAfter: money('125.00') }));
    props.createdAt.setUTCFullYear(2000);
    props.balanceAfter = money('0.00');
    debit.createdAt.setUTCFullYear(2000);
    expect(debit.isBalanced()).toBe(true);
    expect(credit.isBalanced()).toBe(true);
    expect(debit.createdAt).toEqual(at());
    expect(debit.balanceAfter.toString()).toBe('75.00 BRL');
    expect(Reflect.set(debit, 'money', money('0.00'))).toBe(false);
    expect(Object.isFrozen(debit)).toBe(true);
  });
  test('rejeita aritmética errada, saldo negativo, dinheiro zero/negativo e moedas distintas', () => {
    expect(() => WalletLedgerEntry.create(entryState({ balanceAfter: money('74.99') }))).toThrow(DomainValidationError);
    expect(() => WalletLedgerEntry.create(entryState({ balanceBefore: money('0.00'), balanceAfter: money('25.00').negate() }))).toThrow(DomainValidationError);
    expectCode(() => WalletLedgerEntry.create(entryState({ money: money('0.00') })), FailureCode.AmountMustBePositive);
    expectCode(() => WalletLedgerEntry.create(entryState({ money: money().negate() })), FailureCode.AmountMustBePositive);
    expectCode(() => WalletLedgerEntry.create(entryState({ balanceAfter: money('75.00', 'USD') })), FailureCode.CurrencyMismatch);
  });
  test('rehydrate preserva lançamento sem gerar movimentação; diagnóstico não corrige dados', () => {
    const saved = WalletLedgerEntry.rehydrate(entryState());
    expect(saved.isBalanced()).toBe(true);
    expect(saved.walletVersion).toBe(2);
    const corrupt = WalletLedgerEntry.rehydrate(entryState({ balanceAfter: money('1.00') }));
    expect(corrupt.balanceAfter.toString()).toBe('1.00 BRL');
    expect(corrupt.isBalanced()).toBe(false);
  });
});
