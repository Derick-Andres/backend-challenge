import { expect, test } from 'bun:test';
import { ExactBigIntType } from '../../src/infrastructure/database/records.js';
import { MoneyPersistenceError } from '../../src/infrastructure/database/money-converter.js';

test('custom type do ORM rejeita driver number e preserva bigint exato nos dois sentidos', () => {
  const type = new ExactBigIntType();
  expect(type.convertToJSValue('9007199254740993')).toBe(9007199254740993n);
  expect(type.convertToDatabaseValue(9007199254740993n)).toBe('9007199254740993');
  expect(() => type.convertToJSValue(10)).toThrow(MoneyPersistenceError);
  expect(() => type.convertToDatabaseValue(10 as never)).toThrow(MoneyPersistenceError);
  expect(() => type.convertToJSValue('9223372036854775808')).toThrow(MoneyPersistenceError);
});
