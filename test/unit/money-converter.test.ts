import { describe, expect, test } from 'bun:test';
import { InvalidMoneyError, Money } from '../../src/domain/money.js';
import { MoneyPersistenceError, moneyFromDatabase, moneyToDatabase } from '../../src/infrastructure/database/money-converter.js';

describe('conversor de Money / BIGINT', () => {
  test.each([
    { minorUnits: 0n, amount: '0.00' },
    { minorUnits: 1n, amount: '0.01' },
    { minorUnits: -1n, amount: '-0.01' },
    { minorUnits: 9007199254740993n, amount: '90071992547409.93' },
    { minorUnits: 9223372036854775807n, amount: '92233720368547758.07' },
    { minorUnits: -9223372036854775808n, amount: '-92233720368547758.08' },
  ])('converte exatamente bigint e string, inclusive os limites: %p', ({ minorUnits, amount }) => {
    const money = Money.rehydrate(minorUnits, 'BRL');
    expect(moneyToDatabase(money)).toBe(minorUnits.toString());
    expect(moneyFromDatabase(minorUnits, 'BRL').toJSON()).toEqual({ amount, currency: 'BRL' });
    expect(moneyFromDatabase(minorUnits.toString(), 'BRL').equals(money)).toBe(true);
  });

  test.each([9223372036854775808n, -9223372036854775809n, 18446744073709551614n])('rejeita overflow apenas ao persistir/ler: %p', (value) => {
    const money = Money.rehydrate(value, 'BRL');
    expect(money.minorUnits).toBe(value);
    expect(() => moneyToDatabase(money)).toThrow(MoneyPersistenceError);
    expect(() => moneyFromDatabase(value, 'BRL')).toThrow(MoneyPersistenceError);
    expect(() => moneyFromDatabase(value.toString(), 'BRL')).toThrow(MoneyPersistenceError);
  });

  test('negação do mínimo BIGINT cabe no domínio, mas não na persistência', () => {
    const minimum = moneyFromDatabase('-9223372036854775808', 'BRL');
    const positive = minimum.negate();
    expect(positive.toString()).toBe('92233720368547758.08 BRL');
    expect(() => moneyToDatabase(positive)).toThrow(MoneyPersistenceError);
    expect(moneyToDatabase(positive.subtract(Money.from({ amount: '0.01', currency: 'BRL' })))).toBe('9223372036854775807');
  });

  test.each([
    0, 1, -1, 9007199254740992, NaN, Infinity, -Infinity,
    '', '1.00', '1e2', '+1', '01', '-01', '-0', ' 1', '1 ', '1\n', 'NaN', 'Infinity',
    null, undefined, true, {}, [], new String('1'), Object(1n),
  ].map((value) => ({ value })))('rejeita tipo/formato inválido do driver, inclusive number seguro: %p', ({ value }) => {
    expect(() => moneyFromDatabase(value, 'BRL')).toThrow(MoneyPersistenceError);
  });

  test('valida moeda da persistência e mantém moedas distintas', () => {
    expect(moneyFromDatabase('123', 'USD').toString()).toBe('1.23 USD');
    expect(() => moneyFromDatabase('123', 'ZZZ')).toThrow(InvalidMoneyError);
    expect(() => moneyToDatabase({ minorUnits: 123n } as Money)).toThrow(MoneyPersistenceError);
  });
});
