import { assertText, copyDate, immutableJson } from './primitives.js';
import type { DeepReadonly } from './primitives.js';

export interface EventContext {
  eventId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
}

export interface IntegrationEventProps<T> extends EventContext { aggregateId: string; data: T }

export interface EventEnvelope<T> {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string;
  version: number;
  data: T;
}

export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;
  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId: string | undefined;
  readonly data: DeepReadonly<T>;
  readonly #occurredAt: Date;

  protected constructor(props: IntegrationEventProps<T>) {
    for (const value of [props.eventId, props.aggregateId, props.correlationId]) assertText(value, 'Identidade do evento');
    if (props.causationId !== undefined) assertText(props.causationId, 'causationId');
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.#occurredAt = copyDate(props.occurredAt);
    this.data = immutableJson(props.data);
  }

  get occurredAt(): Date { return copyDate(this.#occurredAt); }
  toJSON(): DeepReadonly<EventEnvelope<DeepReadonly<T>>> {
    return immutableJson({
      eventId: this.eventId, eventType: this.eventType, aggregateId: this.aggregateId,
      correlationId: this.correlationId, ...(this.causationId === undefined ? {} : { causationId: this.causationId }),
      occurredAt: this.#occurredAt.toISOString(), version: this.version, data: this.data,
    });
  }
}
