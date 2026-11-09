import {
  BusinessRuleError, DomainValidationError, FailureCode, IdempotencyConflictError, InvalidTransactionStateError,
} from './errors.js';
import type { RejectionCode } from './errors.js';
import type { Money } from './money.js';
import { assertMoney, assertText, copyDate } from './primitives.js';
import { LedgerDirection } from './wallet-ledger-entry.js';

export enum WagerTransactionKind {
  Opening = 'OPENING', Bet = 'BET', Win = 'WIN', Loss = 'LOSS', Refund = 'REFUND', Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING', PendingReference = 'PENDING_REFERENCE', Processed = 'PROCESSED', Rejected = 'REJECTED', Failed = 'FAILED',
}

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: Exclude<WagerTransactionKind, WagerTransactionKind.Opening>;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
}

export interface WagerTransactionState {
  id: string;
  providerId?: string;
  externalTransactionId?: string;
  idempotencyKey?: string;
  payloadHash?: string;
  walletId: string;
  playerId: string;
  roundId?: string;
  gameId?: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  completedAt?: Date;
}

export class WagerTransaction {
  readonly #state: WagerTransactionState;

  private constructor(state: WagerTransactionState) {
    for (const value of [state.id, state.walletId, state.playerId]) assertText(value, 'Identidade da transação');
    assertMoney(state.money);
    if (!Object.values(WagerTransactionKind).includes(state.kind) || !Object.values(WagerTransactionStatus).includes(state.status)) {
      throw new DomainValidationError('Kind/status inválido');
    }
    this.#state = { ...state, createdAt: copyDate(state.createdAt) };
    if (state.processedAt !== undefined) this.#state.processedAt = copyDate(state.processedAt);
    if (state.completedAt !== undefined) this.#state.completedAt = copyDate(state.completedAt);
    Object.freeze(this);
  }

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (!Object.values(WagerTransactionKind).includes(props.kind) || (props.kind as WagerTransactionKind) === WagerTransactionKind.Opening) {
      throw new DomainValidationError('OPENING não é uma operação externa');
    }
    for (const value of [props.providerId, props.externalTransactionId, props.idempotencyKey, props.payloadHash, props.roundId, props.gameId]) {
      assertText(value, 'Campo de negócio externo');
    }
    const transaction = new WagerTransaction({
      id: props.id, providerId: props.providerId, externalTransactionId: props.externalTransactionId,
      idempotencyKey: props.idempotencyKey, payloadHash: props.payloadHash, walletId: props.walletId,
      playerId: props.playerId, roundId: props.roundId, gameId: props.gameId, kind: props.kind,
      money: props.money, createdAt: props.createdAt, status: WagerTransactionStatus.Pending,
      ...(props.referenceExternalTransactionId === undefined ? {} : { referenceExternalTransactionId: props.referenceExternalTransactionId }),
    });
    if (transaction.money.isNegative()) throw new DomainValidationError('Quantia de entrada não pode ser negativa');
    if (transaction.requiresReference() && props.referenceExternalTransactionId === undefined) {
      throw new BusinessRuleError(FailureCode.ReferenceRequired);
    }
    if (props.referenceExternalTransactionId !== undefined) {
      assertText(props.referenceExternalTransactionId, 'Referência externa');
      if (props.kind === WagerTransactionKind.Bet || props.kind === WagerTransactionKind.Loss) {
        throw new BusinessRuleError(FailureCode.ReferenceNotAllowed);
      }
    }
    return transaction;
  }

  static opening(props: { id: string; walletId: string; playerId: string; money: Money; createdAt: Date }): WagerTransaction {
    const transaction = new WagerTransaction({
      id: props.id, walletId: props.walletId, playerId: props.playerId, money: props.money,
      createdAt: props.createdAt, kind: WagerTransactionKind.Opening, status: WagerTransactionStatus.Pending,
    });
    if (!transaction.money.isPositive()) throw new BusinessRuleError(FailureCode.AmountMustBePositive);
    return transaction;
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction { return new WagerTransaction(state); }
  get id(): string { return this.#state.id; }
  get providerId(): string | undefined { return this.#state.providerId; }
  get externalTransactionId(): string | undefined { return this.#state.externalTransactionId; }
  get idempotencyKey(): string | undefined { return this.#state.idempotencyKey; }
  get payloadHash(): string | undefined { return this.#state.payloadHash; }
  get walletId(): string { return this.#state.walletId; }
  get playerId(): string { return this.#state.playerId; }
  get roundId(): string | undefined { return this.#state.roundId; }
  get gameId(): string | undefined { return this.#state.gameId; }
  get kind(): WagerTransactionKind { return this.#state.kind; }
  get money(): Money { return this.#state.money; }
  get referenceExternalTransactionId(): string | undefined { return this.#state.referenceExternalTransactionId; }
  get referenceTransactionId(): string | undefined { return this.#state.referenceTransactionId; }
  get status(): WagerTransactionStatus { return this.#state.status; }
  get failureCode(): FailureCode | undefined { return this.#state.failureCode; }
  get createdAt(): Date { return copyDate(this.#state.createdAt); }
  get processedAt(): Date | undefined { return this.#state.processedAt === undefined ? undefined : copyDate(this.#state.processedAt); }
  get completedAt(): Date | undefined { return this.#state.completedAt === undefined ? undefined : copyDate(this.#state.completedAt); }

  isTerminal(): boolean {
    return [WagerTransactionStatus.Processed, WagerTransactionStatus.Rejected, WagerTransactionStatus.Failed].includes(this.status);
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss && !this.money.isZero()
      && this.status !== WagerTransactionStatus.Rejected && this.status !== WagerTransactionStatus.Failed;
  }

  requiresReference(): boolean { return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback; }
  matchesPayload(hash: string): boolean { return this.payloadHash === hash; }
  assertMatchesPayload(hash: string): void {
    if (!this.matchesPayload(hash)) throw new IdempotencyConflictError('Mesmo identificador com payload divergente');
  }

  validateForProcessing(reference?: WagerTransaction, processedReversals: readonly WagerTransaction[] = []): void {
    this.assertMutable();
    if (this.kind !== WagerTransactionKind.Loss && !this.money.isPositive()) throw new BusinessRuleError(FailureCode.AmountMustBePositive);
    this.validateReference(reference);
    if (this.requiresReference() && processedReversals.some((previous) =>
      previous.status === WagerTransactionStatus.Processed && previous.kind === this.kind
      && previous.referenceTransactionId === reference?.id && previous.providerId === this.providerId)) {
      throw new BusinessRuleError(FailureCode.AlreadyReversedByKind);
    }
  }

  markProcessed(reference: WagerTransaction | undefined, at: Date, processedReversals: readonly WagerTransaction[] = []): void {
    this.validateForProcessing(reference, processedReversals);
    const completedAt = copyDate(at);
    this.#state.status = WagerTransactionStatus.Processed;
    if (reference !== undefined) this.#state.referenceTransactionId = reference.id;
    this.#state.processedAt = completedAt;
    this.#state.completedAt = completedAt;
  }

  markPendingReference(): void {
    this.assertMutable();
    if (this.status !== WagerTransactionStatus.Pending || this.referenceExternalTransactionId === undefined) {
      throw new InvalidTransactionStateError('Apenas PENDING com referência pode entrar em espera');
    }
    this.#state.status = WagerTransactionStatus.PendingReference;
  }

  reject(code: RejectionCode, at: Date): void {
    this.assertMutable();
    if (!Object.values(FailureCode).includes(code) || (code as FailureCode) === FailureCode.PermanentProcessingFailure) {
      throw new DomainValidationError('Código de rejeição inválido');
    }
    const completedAt = copyDate(at);
    this.#state.status = WagerTransactionStatus.Rejected;
    this.#state.failureCode = code;
    this.#state.completedAt = completedAt;
  }

  fail(code: FailureCode.PermanentProcessingFailure, at: Date): void {
    this.assertMutable();
    if (code !== FailureCode.PermanentProcessingFailure) throw new DomainValidationError('Falha exige código permanente de infraestrutura');
    const completedAt = copyDate(at);
    this.#state.status = WagerTransactionStatus.Failed;
    this.#state.failureCode = code;
    this.#state.completedAt = completedAt;
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection | undefined {
    this.validateReference(reference);
    switch (this.kind) {
      case WagerTransactionKind.Loss: return undefined;
      case WagerTransactionKind.Bet: return LedgerDirection.Debit;
      case WagerTransactionKind.Rollback:
        return reference?.kind === WagerTransactionKind.Bet ? LedgerDirection.Credit : LedgerDirection.Debit;
      default: return LedgerDirection.Credit;
    }
  }

  private assertMutable(): void {
    if (this.isTerminal()) throw new InvalidTransactionStateError(`Transação terminal: ${this.status}`);
  }

  private validateReference(reference?: WagerTransaction): void {
    const externalId = this.referenceExternalTransactionId;
    if (externalId === undefined) {
      if (this.requiresReference()) throw new BusinessRuleError(FailureCode.ReferenceRequired);
      if (reference !== undefined) throw new BusinessRuleError(FailureCode.ReferenceNotAllowed);
      return;
    }
    if (externalId === this.externalTransactionId || reference?.id === this.id) throw new BusinessRuleError(FailureCode.SelfReference);
    if (reference === undefined) throw new BusinessRuleError(FailureCode.ReferenceNotFound);
    if (reference.externalTransactionId !== externalId || reference.providerId !== this.providerId
      || reference.walletId !== this.walletId || reference.playerId !== this.playerId || reference.roundId !== this.roundId) {
      throw new BusinessRuleError(FailureCode.ReferenceContextMismatch);
    }
    if (reference.money.currency !== this.money.currency) throw new BusinessRuleError(FailureCode.CurrencyMismatch);
    const allowed = this.kind === WagerTransactionKind.Rollback
      ? [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund] : [WagerTransactionKind.Bet];
    if (!allowed.includes(reference.kind)) throw new BusinessRuleError(FailureCode.ReferenceKindInvalid);
    if (reference.status !== WagerTransactionStatus.Processed) {
      throw new BusinessRuleError(reference.isTerminal() ? FailureCode.ReferenceNotProcessed : FailureCode.ReferenceNotReady);
    }
    if (this.requiresReference() && !this.money.equals(reference.money)) throw new BusinessRuleError(FailureCode.ReferenceAmountMismatch);
  }
}
