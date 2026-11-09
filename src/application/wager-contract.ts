import { createHash } from 'node:crypto';
import { z } from 'zod';
import { WagerTransactionKind } from '../domain/wager-transaction.js';
import { identityContract, moneyContract } from './wallet-service.js';

export const wagerCommandContract = z.object({
  providerId: identityContract, externalTransactionId: identityContract, playerId: identityContract,
  walletId: identityContract, roundId: identityContract, gameId: identityContract,
  kind: z.enum([WagerTransactionKind.Bet,WagerTransactionKind.Win,WagerTransactionKind.Loss,WagerTransactionKind.Refund,WagerTransactionKind.Rollback]), money: moneyContract,
  referenceExternalTransactionId: identityContract.optional(),
}).strict();
export type WagerCommand = z.infer<typeof wagerCommandContract>;

export function canonicalJson(value: unknown): string {
  if (value===null || typeof value!=='object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string,unknown>)[key])}`).join(',')}}`;
}
export function payloadHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value),'utf8').digest('hex');
}
// Chaves explícitas: nunca inclui header, correlationId ou atributos do transporte.
export function businessPayloadHash(command: WagerCommand): string {
  return payloadHash({ providerId: command.providerId, externalTransactionId: command.externalTransactionId, playerId: command.playerId,
    walletId: command.walletId, roundId: command.roundId, gameId: command.gameId, kind: command.kind,
    money: { amount: command.money.amount, currency: command.money.currency },
    ...(command.referenceExternalTransactionId===undefined ? {} : { referenceExternalTransactionId: command.referenceExternalTransactionId }),
  });
}
