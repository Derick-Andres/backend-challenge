import { BusinessRuleError, DomainValidationError, FailureCode } from './errors.js';
import { Money } from './money.js';
import { assertCounter, assertMoney, assertText, copyDate } from './primitives.js';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry.js';
import { WagerTransaction, WagerTransactionKind } from './wager-transaction.js';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ApplyTransactionProps {
  at: Date;
  entryId?: string;
  reference?: WagerTransaction;
  processedReversals?: readonly WagerTransaction[];
}

export class Wallet {
  readonly #state: WalletState;
  readonly #entries: WalletLedgerEntry[] = [];
  readonly #applied: WagerTransaction[] = [];
  #openingTransaction: WagerTransaction | undefined;

  private constructor(state: WalletState) {
    assertText(state.id, 'walletId');
    assertText(state.playerId, 'playerId');
    assertMoney(state.balance);
    if (state.balance.currency !== state.currency) throw new BusinessRuleError(FailureCode.CurrencyMismatch);
    if (state.balance.isNegative()) throw new DomainValidationError('Wallet não pode ter saldo negativo');
    assertCounter(state.version, 1);
    this.#state = { ...state, createdAt: copyDate(state.createdAt), updatedAt: copyDate(state.updatedAt) };
    Object.freeze(this);
  }

  static open(props: {
    id: string; playerId: string; initialBalance: Money; createdAt: Date;
    opening?: { transactionId: string; entryId: string };
  }): Wallet {
    assertMoney(props.initialBalance);
    if (props.initialBalance.isNegative()) throw new DomainValidationError('Saldo inicial negativo');
    const wallet = new Wallet({
      id: props.id, playerId: props.playerId, currency: props.initialBalance.currency,
      balance: Money.zero(props.initialBalance.currency), version: 1, createdAt: props.createdAt, updatedAt: props.createdAt,
    });
    if (props.initialBalance.isPositive()) {
      if (!props.opening) throw new DomainValidationError('Abertura positiva exige identidades de transação e ledger');
      const transaction = WagerTransaction.opening({
        id: props.opening.transactionId, walletId: props.id, playerId: props.playerId, money: props.initialBalance, createdAt: props.createdAt,
      });
      const entry = WalletLedgerEntry.create({
        id: props.opening.entryId, walletId: props.id, transactionId: transaction.id, walletVersion: 1,
        direction: LedgerDirection.Credit, money: props.initialBalance, balanceBefore: wallet.balance,
        balanceAfter: props.initialBalance, createdAt: props.createdAt,
      });
      transaction.markProcessed(undefined, props.createdAt);
      wallet.#state.balance = props.initialBalance;
      wallet.#entries.push(entry);
      wallet.#applied.push(transaction);
      wallet.#openingTransaction = transaction;
    }
    return wallet;
  }

  static rehydrate(state: WalletState): Wallet { return new Wallet(state); }
  get id(): string { return this.#state.id; }
  get playerId(): string { return this.#state.playerId; }
  get currency(): string { return this.#state.currency; }
  get balance(): Money { return this.#state.balance; }
  get version(): number { return this.#state.version; }
  get createdAt(): Date { return copyDate(this.#state.createdAt); }
  get updatedAt(): Date { return copyDate(this.#state.updatedAt); }
  get openingTransaction(): WagerTransaction | undefined { return this.#openingTransaction; }
  get ledgerEntries(): readonly WalletLedgerEntry[] { return Object.freeze([...this.#entries]); }

  assertTransactionContext(transaction: WagerTransaction): void {
    if (transaction.walletId !== this.id) throw new BusinessRuleError(FailureCode.WalletMismatch);
    if (transaction.playerId !== this.playerId) throw new BusinessRuleError(FailureCode.WalletPlayerMismatch);
    if (transaction.money.currency !== this.currency) throw new BusinessRuleError(FailureCode.CurrencyMismatch);
  }

  // Único caminho de movimentação: o lançamento fica registrado mesmo se o retorno for ignorado.
  apply(transaction: WagerTransaction, props: ApplyTransactionProps): WalletLedgerEntry | undefined {
    const reversals = [...this.#applied, ...(props.processedReversals ?? [])];
    transaction.validateForProcessing(props.reference, reversals);
    if (transaction.kind === WagerTransactionKind.Opening) throw new DomainValidationError('OPENING é exclusivo de Wallet.open');
    this.assertTransactionContext(transaction);
    const at = copyDate(props.at);
    if (transaction.kind === WagerTransactionKind.Loss) {
      transaction.markProcessed(undefined, at);
      this.#applied.push(transaction);
      return undefined;
    }
    if (this.#entries.some((entry) => entry.transactionId === transaction.id)) throw new DomainValidationError('Transação já registrada neste agregado');
    assertText(props.entryId, 'entryId');
    const version = this.version + 1;
    assertCounter(version, 1);
    const direction = transaction.ledgerDirectionFor(props.reference);
    if (direction === undefined) throw new DomainValidationError('Movimentação exige direção');
    if (direction === LedgerDirection.Debit && this.balance.isLessThan(transaction.money)) {
      throw new BusinessRuleError(transaction.kind === WagerTransactionKind.Rollback
        ? FailureCode.ReversalInsufficientFunds : FailureCode.InsufficientFunds);
    }
    const balanceAfter = direction === LedgerDirection.Debit ? this.balance.subtract(transaction.money) : this.balance.add(transaction.money);
    const entry = WalletLedgerEntry.create({
      id: props.entryId, walletId: this.id, transactionId: transaction.id, walletVersion: version,
      direction, money: transaction.money, balanceBefore: this.balance, balanceAfter, createdAt: at,
    });
    transaction.markProcessed(props.reference, at, reversals);
    this.#state.balance = balanceAfter;
    this.#state.version = version;
    this.#state.updatedAt = at;
    this.#entries.push(entry);
    this.#applied.push(transaction);
    return entry;
  }
}
