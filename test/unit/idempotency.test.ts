import { describe, expect, test } from 'bun:test';
import { businessPayloadHash, canonicalJson, wagerCommandContract } from '../../src/application/wager-contract.js';

const input = { providerId: 'p', externalTransactionId: 'e', playerId: 'player', walletId: 'wallet', roundId: 'round', gameId: 'game',
  kind: 'BET', money: { amount: '1.00', currency: 'BRL' } };
describe('hash de negócio v1', () => {
  test('ordem recursiva de chaves não muda os bytes canônicos ou hash', () => {
    expect(canonicalJson({ b: 2, a: { y: 1, x: 'value' } })).toBe('{"a":{"x":"value","y":1},"b":2}');
    const a = wagerCommandContract.parse(input);
    const b = wagerCommandContract.parse(Object.fromEntries(Object.entries({ ...input, money: { currency: 'BRL', amount: '1.00' } }).reverse()));
    expect(businessPayloadHash(a)).toBe(businessPayloadHash(b));
    expect(businessPayloadHash(a)).toHaveLength(64);
  });
  test.each(['providerId','externalTransactionId','playerId','walletId','roundId','gameId'])('mudar %s altera o hash', (field) => {
    expect(businessPayloadHash(wagerCommandContract.parse({ ...input,[field]: 'different' }))).not.toBe(businessPayloadHash(wagerCommandContract.parse(input)));
  });
  test('tipo, amount, currency e referência são conteúdo de negócio', () => {
    const original = businessPayloadHash(wagerCommandContract.parse(input));
    for (const changed of [{ kind: 'WIN' },{ money: { amount: '1.01', currency: 'BRL' } },{ money: { amount: '1.00', currency: 'USD' } },{ referenceExternalTransactionId: 'ref' }]) {
      expect(businessPayloadHash(wagerCommandContract.parse({ ...input,...changed }))).not.toBe(original);
    }
  });
  test('header e metadados de transporte não entram no hash; ausência de referência é omissão', () => {
    const parsed = wagerCommandContract.parse(input);
    const withTransport = { ...parsed, idempotencyKey: 'another-key', messageId: 'message', occurredAt: 'now', correlationId: 'different' };
    expect(businessPayloadHash(withTransport)).toBe(businessPayloadHash(parsed));
    expect(businessPayloadHash({ ...parsed, referenceExternalTransactionId: undefined })).toBe(businessPayloadHash(parsed));
    expect(() => wagerCommandContract.parse({ ...input, referenceExternalTransactionId: null })).toThrow();
    expect(() => wagerCommandContract.parse({ ...input, unknown: 'not-business' })).toThrow();
  });
});
