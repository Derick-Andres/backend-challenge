export class ApplicationError extends Error {
  override readonly name = 'ApplicationError';
  constructor(readonly status: number, readonly code: string) { super(code); }
}
