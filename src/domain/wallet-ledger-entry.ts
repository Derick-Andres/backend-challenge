import { BusinessRuleError, DomainValidationError, FailureCode } from './errors.js';
import type { Money } from './money.js';
import { assertCounter, assertMoney, assertText, copyDate } from './primitives.js';

export enum LedgerDirection { Debit = 'DEBIT', Credit = 'CREDIT' }

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  walletVersion: number;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export class WalletLedgerEntry {
  readonly #state: Readonly<LedgerEntryState>;

  private constructor(state: LedgerEntryState) {
    for (const value of [state.id, state.walletId, state.transactionId]) assertText(value, 'Identidade do ledger');
    assertCounter(state.walletVersion, 1);
    for (const money of [state.money, state.balanceBefore, state.balanceAfter]) assertMoney(money);
    if (!Object.values(LedgerDirection).includes(state.direction)) throw new DomainValidationError('Direção inválida');
    this.#state = Object.freeze({ ...state, createdAt: copyDate(state.createdAt) });
    Object.freeze(this);
  }

  static create(props: LedgerEntryState): WalletLedgerEntry {
    const entry = new WalletLedgerEntry(props);
    if (!entry.money.isPositive()) throw new BusinessRuleError(FailureCode.AmountMustBePositive);
    if (entry.money.currency !== entry.balanceBefore.currency || entry.money.currency !== entry.balanceAfter.currency) {
      throw new BusinessRuleError(FailureCode.CurrencyMismatch);
    }
    if (entry.balanceBefore.isNegative() || entry.balanceAfter.isNegative() || !entry.isBalanced()) {
      throw new DomainValidationError('Aritmética ou saldo inválido no ledger');
    }
    return entry;
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry { return new WalletLedgerEntry(state); }
  get id(): string { return this.#state.id; }
  get walletId(): string { return this.#state.walletId; }
  get transactionId(): string { return this.#state.transactionId; }
  get walletVersion(): number { return this.#state.walletVersion; }
  get direction(): LedgerDirection { return this.#state.direction; }
  get money(): Money { return this.#state.money; }
  get balanceBefore(): Money { return this.#state.balanceBefore; }
  get balanceAfter(): Money { return this.#state.balanceAfter; }
  get createdAt(): Date { return copyDate(this.#state.createdAt); }

  isBalanced(): boolean {
    if (this.money.currency !== this.balanceBefore.currency || this.money.currency !== this.balanceAfter.currency) return false;
    const expected = this.direction === LedgerDirection.Debit
      ? this.balanceBefore.subtract(this.money) : this.balanceBefore.add(this.money);
    return expected.equals(this.balanceAfter);
  }
}
