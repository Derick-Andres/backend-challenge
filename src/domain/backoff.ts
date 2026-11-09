import { DomainValidationError } from './errors.js';
import { assertCounter } from './primitives.js';

export interface BackoffPolicy { baseDelayMs: number; maxDelayMs: number }

// Equal jitter: metade da janela exponencial + uma amostra na outra metade.
export function backoffDelay(attempt: number, random: () => number, policy: BackoffPolicy): number {
  assertCounter(attempt, 1);
  assertCounter(policy.baseDelayMs, 1);
  assertCounter(policy.maxDelayMs, policy.baseDelayMs);
  const sample = random();
  if (!Number.isFinite(sample) || sample < 0 || sample >= 1) throw new DomainValidationError('Aleatoriedade exige amostra em [0, 1)');
  const window = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.min(attempt - 1, 1023));
  return Math.min(window - 1, Math.floor(window / 2 + sample * window / 2));
}
