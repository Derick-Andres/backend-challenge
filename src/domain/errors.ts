export enum FailureCode {
  AmountMustBePositive = 'AMOUNT_MUST_BE_POSITIVE',
  BalanceLimitExceeded = 'BALANCE_LIMIT_EXCEEDED',
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  ReversalInsufficientFunds = 'REVERSAL_INSUFFICIENT_FUNDS',
  WalletMismatch = 'WALLET_MISMATCH',
  WalletPlayerMismatch = 'WALLET_PLAYER_MISMATCH',
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  ReferenceRequired = 'REFERENCE_REQUIRED',
  ReferenceNotAllowed = 'REFERENCE_NOT_ALLOWED',
  SelfReference = 'SELF_REFERENCE',
  ReferenceKindInvalid = 'REFERENCE_KIND_INVALID',
  ReferenceContextMismatch = 'REFERENCE_CONTEXT_MISMATCH',
  ReferenceAmountMismatch = 'REFERENCE_AMOUNT_MISMATCH',
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  ReferenceNotReady = 'REFERENCE_NOT_READY',
  AlreadyReversedByKind = 'ALREADY_REVERSED_BY_KIND',
  PermanentProcessingFailure = 'PERMANENT_PROCESSING_FAILURE',
}

export type RejectionCode = Exclude<FailureCode, FailureCode.PermanentProcessingFailure>;

export class DomainValidationError extends Error {
  override readonly name = 'DomainValidationError';
}

export class BusinessRuleError extends Error {
  override readonly name = 'BusinessRuleError';
  constructor(readonly code: RejectionCode) { super(code); }
}

export class InvalidTransactionStateError extends Error {
  override readonly name = 'InvalidTransactionStateError';
}

export class InvalidMessageStateError extends Error {
  override readonly name = 'InvalidMessageStateError';
}

export class IdempotencyConflictError extends Error {
  override readonly name = 'IdempotencyConflictError';
}
