import { IdempotencyConflictError, InvalidMessageStateError } from './errors.js';
import { assertText, copyDate } from './primitives.js';

export interface InboxMessageState {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt?: Date;
}

export class InboxMessage {
  readonly #state: InboxMessageState;

  private constructor(state: InboxMessageState) {
    for (const value of [state.messageId, state.consumerName, state.payloadHash]) assertText(value, 'Identidade da inbox');
    this.#state = { ...state, receivedAt: copyDate(state.receivedAt) };
    if (state.processedAt !== undefined) this.#state.processedAt = copyDate(state.processedAt);
    Object.freeze(this);
  }

  static receive(props: Omit<InboxMessageState, 'processedAt'>): InboxMessage {
    return new InboxMessage({ messageId: props.messageId, consumerName: props.consumerName, payloadHash: props.payloadHash, receivedAt: props.receivedAt });
  }
  static rehydrate(state: InboxMessageState): InboxMessage { return new InboxMessage(state); }
  get messageId(): string { return this.#state.messageId; }
  get consumerName(): string { return this.#state.consumerName; }
  get payloadHash(): string { return this.#state.payloadHash; }
  get receivedAt(): Date { return copyDate(this.#state.receivedAt); }
  get processedAt(): Date | undefined { return this.#state.processedAt === undefined ? undefined : copyDate(this.#state.processedAt); }
  isProcessed(): boolean { return this.#state.processedAt !== undefined; }
  matchesPayload(hash: string): boolean { return this.payloadHash === hash; }
  assertMatchesPayload(hash: string): void {
    if (!this.matchesPayload(hash)) throw new IdempotencyConflictError('messageId reutilizado com payload divergente');
  }
  markProcessed(at: Date): void {
    if (this.isProcessed()) throw new InvalidMessageStateError('Inbox já concluída');
    this.#state.processedAt = copyDate(at);
  }
}
