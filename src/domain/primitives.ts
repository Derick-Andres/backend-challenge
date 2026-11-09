import { DomainValidationError } from './errors.js';
import { Money } from './money.js';

export function assertText(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new DomainValidationError(`${field} deve ser string não vazia`);
}

export function assertMoney(value: unknown): asserts value is Money {
  if (!(value instanceof Money)) throw new DomainValidationError('Esperado Money');
}

export function copyDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new DomainValidationError('Data inválida');
  return new Date(value.getTime());
}

export function assertCounter(value: number, minimum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum) throw new DomainValidationError('Contador inválido');
}

export type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;

// Copia somente JSON puro: Money/Date/bigint precisam ser serializados explicitamente.
export function immutableJson<T>(value: T): DeepReadonly<T> {
  const ancestors = new Set<object>();
  const copy = (input: unknown): unknown => {
    if (input === null || typeof input === 'string' || typeof input === 'boolean') return input;
    if (typeof input === 'number' && Number.isFinite(input)) return input;
    if (typeof input !== 'object' || ancestors.has(input)) throw new DomainValidationError('Payload deve ser JSON sem ciclos');
    if (!Array.isArray(input) && Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) {
      throw new DomainValidationError('Payload exige objetos JSON, não instâncias de domínio');
    }
    ancestors.add(input);
    const result = Array.isArray(input)
      ? input.map(copy)
      : Object.fromEntries(Object.entries(input).map(([key, item]) => [key, copy(item)]));
    ancestors.delete(input);
    return Object.freeze(result);
  };
  return copy(value) as DeepReadonly<T>;
}
