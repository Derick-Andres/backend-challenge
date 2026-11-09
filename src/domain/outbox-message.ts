import { backoffDelay } from './backoff.js';
import type { BackoffPolicy } from './backoff.js';
import { InvalidMessageStateError } from './errors.js';
import type { IntegrationEvent } from './integration-event.js';
import { assertCounter, assertText, copyDate, immutableJson } from './primitives.js';
import type { DeepReadonly } from './primitives.js';

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

export class OutboxMessage {
  readonly #state: Omit<OutboxMessageState, 'payload'> & { payload: DeepReadonly<Record<string, unknown>> };

  private constructor(state: OutboxMessageState) {
    for (const value of [state.id, state.aggregateId, state.eventType]) assertText(value, 'Identidade da outbox');
    assertCounter(state.attempts, 0);
    this.#state = { ...state, payload: immutableJson(state.payload), occurredAt: copyDate(state.occurredAt) };
    if (state.nextAttemptAt !== undefined) this.#state.nextAttemptAt = copyDate(state.nextAttemptAt);
    if (state.publishedAt !== undefined) this.#state.publishedAt = copyDate(state.publishedAt);
    Object.freeze(this);
  }

  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    return new OutboxMessage({
      id: event.eventId, aggregateId: event.aggregateId, eventType: event.eventType,
      payload: event.toJSON(), occurredAt: event.occurredAt, attempts: 0,
    });
  }
  static rehydrate(state: OutboxMessageState): OutboxMessage { return new OutboxMessage(state); }
  get id(): string { return this.#state.id; }
  get aggregateId(): string { return this.#state.aggregateId; }
  get eventType(): string { return this.#state.eventType; }
  get payload(): DeepReadonly<Record<string, unknown>> { return this.#state.payload; }
  get occurredAt(): Date { return copyDate(this.#state.occurredAt); }
  get attempts(): number { return this.#state.attempts; }
  get nextAttemptAt(): Date | undefined { return this.#state.nextAttemptAt === undefined ? undefined : copyDate(this.#state.nextAttemptAt); }
  get publishedAt(): Date | undefined { return this.#state.publishedAt === undefined ? undefined : copyDate(this.#state.publishedAt); }
  isPending(): boolean { return this.#state.publishedAt === undefined; }
  isDue(now: Date): boolean {
    const timestamp = copyDate(now).getTime();
    return this.isPending() && (this.#state.nextAttemptAt === undefined || this.#state.nextAttemptAt.getTime() <= timestamp);
  }
  markPublished(at: Date): void {
    this.assertPending();
    this.#state.publishedAt = copyDate(at);
  }
  scheduleRetry(now: Date, random: () => number, policy: BackoffPolicy = { baseDelayMs: 1000, maxDelayMs: 60_000 }): void {
    this.assertPending();
    const attempts = this.attempts + 1;
    const timestamp = copyDate(now).getTime();
    const delay = backoffDelay(attempts, random, policy);
    const nextAttemptAt = copyDate(new Date(timestamp + delay));
    this.#state.attempts = attempts;
    this.#state.nextAttemptAt = nextAttemptAt;
  }
  private assertPending(): void {
    if (!this.isPending()) throw new InvalidMessageStateError('Outbox já publicada');
  }
}
