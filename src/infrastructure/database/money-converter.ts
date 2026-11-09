import { Money } from '../../domain/money.js';

export class MoneyPersistenceError extends Error {
  override readonly name = 'MoneyPersistenceError';
}

const bigintMin = -9223372036854775808n;
const bigintMax = 9223372036854775807n;
const integerString = /^(?:0|-?[1-9][0-9]*)$/;

function assertBigintRange(minorUnits: bigint): void {
  if (minorUnits < bigintMin || minorUnits > bigintMax) {
    throw new MoneyPersistenceError('Centavos fora do intervalo de BIGINT do PostgreSQL');
  }
}

// String de centavos para bind no driver; moeda é persistida separadamente.
export function moneyToDatabase(money: Money): string {
  if (!(money instanceof Money)) throw new MoneyPersistenceError('Valor deve ser Money');
  return minorUnitsToDatabase(money.minorUnits);
}

export function minorUnitsToDatabase(value: bigint): string {
  if (typeof value !== 'bigint') throw new MoneyPersistenceError('Centavos devem ser bigint');
  assertBigintRange(value);
  return value.toString();
}

export function minorUnitsFromDatabase(value: unknown): bigint {
  let minorUnits: bigint;
  if (typeof value === 'bigint') {
    minorUnits = value;
  } else if (typeof value === 'string' && integerString.test(value)) {
    minorUnits = BigInt(value);
  } else {
    // Até number seguro é proibido: não podemos recuperar precisão já perdida.
    throw new MoneyPersistenceError('BIGINT do driver deve ser string inteira canônica ou bigint; number não é aceito');
  }
  assertBigintRange(minorUnits);
  return minorUnits;
}

export function moneyFromDatabase(value: unknown, currency: string): Money {
  return Money.rehydrate(minorUnitsFromDatabase(value), currency);
}
