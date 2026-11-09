import { expect } from 'bun:test';
import { BusinessRuleError } from '../../src/domain/errors.js';
import type { RejectionCode } from '../../src/domain/errors.js';
import { Money } from '../../src/domain/money.js';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../../src/domain/wager-transaction.js';
import type { CreateWagerTransactionProps, WagerTransactionState } from '../../src/domain/wager-transaction.js';
import { Wallet } from '../../src/domain/wallet.js';

export const instant = '2026-11-08T12:00:00.000Z';
export const at = (ms = 0): Date => new Date(Date.parse(instant) + ms);
export const money = (amount = '10.00', currency = 'BRL'): Money => Money.from({ amount, currency });

export function txProps(overrides: Partial<CreateWagerTransactionProps> = {}): CreateWagerTransactionProps {
  return {
    id: 'tx', providerId: 'provider', externalTransactionId: 'external', idempotencyKey: 'key', payloadHash: 'hash',
    walletId: 'wallet', playerId: 'player', roundId: 'round', gameId: 'game', kind: WagerTransactionKind.Bet,
    money: money(), createdAt: at(), ...overrides,
  };
}
export const tx = (overrides: Partial<CreateWagerTransactionProps> = {}): WagerTransaction => WagerTransaction.create(txProps(overrides));
export function processed(overrides: Partial<CreateWagerTransactionProps> = {}): WagerTransaction {
  const result = tx({ id: 'reference', externalTransactionId: 'ref-external', ...overrides });
  result.markProcessed(undefined, at(1000));
  return result;
}
export const reversal = (overrides: Partial<CreateWagerTransactionProps> = {}): WagerTransaction => tx({
  kind: WagerTransactionKind.Refund, referenceExternalTransactionId: 'ref-external', ...overrides,
});
export const wallet = (balance = '100.00'): Wallet => Wallet.open({
  id: 'wallet', playerId: 'player', initialBalance: money(balance), createdAt: at(),
  opening: { transactionId: 'opening', entryId: 'opening-entry' },
});
export const txState = (overrides: Partial<WagerTransactionState> = {}): WagerTransactionState => ({
  ...txProps(), status: WagerTransactionStatus.Pending, ...overrides,
});
export function expectCode(action: () => unknown, code: RejectionCode): void {
  try { action(); } catch (error) {
    expect(error).toBeInstanceOf(BusinessRuleError);
    expect((error as BusinessRuleError).code).toBe(code);
    return;
  }
  throw new Error(`Esperado BusinessRuleError ${code}`);
}
