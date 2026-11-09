import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError, Money } from '../../src/domain/money.js';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money', () => {
  test('soma e subtrai centavos exatos, inclusive carry e resultado negativo', () => {
    expect(brl('0.10').add(brl('0.20')).toJSON()).toEqual({ amount: '0.30', currency: 'BRL' });
    expect(brl('0.99').add(brl('0.02')).toString()).toBe('1.01 BRL');
    expect(brl('25.00').subtract(brl('0.01')).toString()).toBe('24.99 BRL');
    expect(brl('0.01').subtract(brl('25.00')).toString()).toBe('-24.99 BRL');
    expect(brl('25.00').subtract(brl('25.00')).isZero()).toBe(true);
  });

  test('compara igualdade e ordem sem converter para number', () => {
    const zero = Money.zero('BRL');
    const positive = brl('1.00');
    const negative = positive.negate();
    expect(zero.isZero()).toBe(true);
    expect(zero.isPositive()).toBe(false);
    expect(zero.isNegative()).toBe(false);
    expect(positive.isPositive()).toBe(true);
    expect(positive.isZero()).toBe(false);
    expect(positive.isNegative()).toBe(false);
    expect(negative.isNegative()).toBe(true);
    expect(negative.isPositive()).toBe(false);
    expect(negative.isZero()).toBe(false);
    expect(negative.isLessThan(zero)).toBe(true);
    expect(zero.isLessThan(positive)).toBe(true);
    expect(positive.isLessThan(zero)).toBe(false);
    expect(positive.isLessThan(brl('1.00'))).toBe(false);
    expect(positive.equals(brl('1.00'))).toBe(true);
    expect(positive.equals(negative)).toBe(false);
    expect(negative.negate().equals(positive)).toBe(true);
  });

  test('opera e serializa negativos internos, inclusive um centavo', () => {
    const negative = Money.zero('BRL').subtract(brl('0.01'));
    expect(negative.toJSON()).toEqual({ amount: '-0.01', currency: 'BRL' });
    expect(JSON.stringify(negative)).toBe('{"amount":"-0.01","currency":"BRL"}');
    expect(negative.add(brl('1.00')).toString()).toBe('0.99 BRL');
    expect(negative.subtract(brl('1.00')).toString()).toBe('-1.01 BRL');
    expect(negative.negate().toString()).toBe('0.01 BRL');
  });

  test('zero sempre tem duas casas e nunca sinal negativo', () => {
    const zero = Money.zero('BRL');
    expect(zero.toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(zero.negate().toString()).toBe('0.00 BRL');
    expect(JSON.stringify(zero.negate())).toBe('{"amount":"0.00","currency":"BRL"}');
    expect(brl('0.00').minorUnits).toBe(0n);
  });

  test('instâncias são imutáveis; operações e DTOs não compartilham estado mutável', () => {
    const original = brl('25.00');
    const operand = brl('1.00');
    for (const result of [original.add(operand), original.subtract(operand), original.negate(), original.add(Money.zero('BRL'))]) {
      expect(result).not.toBe(original);
      expect(Object.isFrozen(result)).toBe(true);
    }
    expect(Reflect.set(original, 'currency', 'USD')).toBe(false);
    expect(Reflect.set(original, 'minorUnits', 999n)).toBe(false);
    const dto = original.toJSON();
    dto.amount = '999.00';
    dto.currency = 'USD';
    expect(original.toString()).toBe('25.00 BRL');
    expect(original.minorUnits).toBe(2500n);
    expect(operand.toString()).toBe('1.00 BRL');
  });

  test('preserva centavos acima de Number.MAX_SAFE_INTEGER', () => {
    const large = brl('90071992547409.93');
    expect(large.minorUnits).toBe(9007199254740993n);
    expect(large.minorUnits > 9007199254740991n).toBe(true);
    expect(large.add(brl('0.01')).toString()).toBe('90071992547409.94 BRL');
    expect(large.subtract(brl('0.01')).toString()).toBe('90071992547409.92 BRL');
    expect(large.equals(brl('90071992547409.93'))).toBe(true);
    expect(large.isLessThan(brl('90071992547409.94'))).toBe(true);
  });

  test('domínio não é limitado por BIGINT e permite intermediários maiores', () => {
    const maximum = brl('92233720368547758.07');
    const double = maximum.add(maximum);
    expect(double.toString()).toBe('184467440737095516.14 BRL');
    expect(double.subtract(maximum).equals(maximum)).toBe(true);
    expect(brl('92233720368547758.08').minorUnits).toBe(9223372036854775808n);
    expect(Money.rehydrate(-18446744073709551614n, 'BRL').toString()).toBe('-184467440737095516.14 BRL');
  });

  test('rehydrate reconstrói centavos assinados sem regras de entrada externa', () => {
    expect(Money.rehydrate(-12345n, 'BRL').toString()).toBe('-123.45 BRL');
    expect(Money.rehydrate(0n, 'USD').toString()).toBe('0.00 USD');
    expect(Money.rehydrate(1n, 'EUR').toString()).toBe('0.01 EUR');
    expect(() => Money.rehydrate(25 as unknown as bigint, 'BRL')).toThrow(InvalidMoneyError);
    expect(() => Money.rehydrate('25' as unknown as bigint, 'BRL')).toThrow(InvalidMoneyError);
  });

  test('aceita códigos ISO conhecidos sem fazer conversão ou inferir escala da moeda', () => {
    for (const currency of ['BRL', 'USD', 'EUR', 'JPY', 'KWD', 'XCG', 'ZWG']) {
      expect(Money.from({ amount: '1.23', currency }).toJSON()).toEqual({ amount: '1.23', currency });
      expect(Money.zero(currency).currency).toBe(currency);
    }
  });

  test('moedas diferentes falham também em igualdade e ordenação', () => {
    const real = brl('1.00');
    const dollar = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => real.add(dollar)).toThrow(CurrencyMismatchError);
    expect(() => real.subtract(dollar)).toThrow(CurrencyMismatchError);
    expect(() => real.equals(dollar)).toThrow(CurrencyMismatchError);
    expect(() => real.isLessThan(dollar)).toThrow(CurrencyMismatchError);
  });

  test('rejeita operando incorreto em runtime em todas as operações binárias', () => {
    const money = brl('1.00');
    const invalid = { currency: 'BRL', minorUnits: 100n } as Money;
    expect(() => money.add(invalid)).toThrow(InvalidMoneyError);
    expect(() => money.subtract(invalid)).toThrow(InvalidMoneyError);
    expect(() => money.equals(invalid)).toThrow(InvalidMoneyError);
    expect(() => money.isLessThan(invalid)).toThrow(InvalidMoneyError);
  });

  test.each([
    '', '1', '1.0', '1.000', '0.005', '-1.00', '-0.00', '+1.00', '01.00', '00.00',
    '1,00', '.01', '1.', '1e2', '1E+2', '1e2.00', ' 1.00', '1.00 ', '\t1.00', '1.00\n',
    '1.00\r\n', '1 .00', 'NaN', 'Infinity', '-Infinity', '0x10.00', '１.００',
    1, 0, -1, NaN, Infinity, -Infinity, 100n, null, undefined, true, [], {}, new String('1.00'),
  ].map((value) => ({ value })))('rejeita amount inválido sem arredondar/coagir: %p', ({ value }) => {
    expect(() => Money.from({ amount: value, currency: 'BRL' })).toThrow(InvalidMoneyError);
  });

  test.each([
    undefined, null, '', 'BR', 'brl', 'Brl', ' BRL', 'BRL ', 'USD\n', 'ZZZ', '123', 123, true,
    new String('BRL'), {}, [],
  ].map((value) => ({ value })))('rejeita moeda inválida nas factories: %p', ({ value }) => {
    expect(() => Money.from({ amount: '1.00', currency: value })).toThrow(InvalidMoneyError);
    expect(() => Money.zero(value as string)).toThrow(InvalidMoneyError);
    expect(() => Money.rehydrate(100n, value as string)).toThrow(InvalidMoneyError);
  });

  test.each([
    undefined, null, '1.00', 100, 100n, true, [], ['1.00', 'BRL'], {},
    { amount: '1.00' }, { currency: 'BRL' }, new Date(), () => ({ amount: '1.00', currency: 'BRL' }),
  ].map((value) => ({ value })))('rejeita contrato incorreto em runtime: %p', ({ value }) => {
    expect(() => Money.from(value)).toThrow(InvalidMoneyError);
  });
});
