import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import type { EntityManager } from '@mikro-orm/postgresql';
import { loadConfig } from '../../src/config/configuration.js';
import { Money } from '../../src/domain/money.js';
import { moneyFromDatabase, moneyToDatabase } from '../../src/infrastructure/database/money-converter.js';
import { ormOptions } from '../../src/infrastructure/database/orm-options.js';

let orm: MikroORM;
let tablesBefore: { tablename: string }[];

async function publicTables() {
  return orm.em.fork().execute<{ tablename: string }[]>(
    "select tablename from pg_tables where schemaname = 'public' order by tablename",
  );
}

async function withTemporaryTable<T>(run: (em: EntityManager) => Promise<T>): Promise<T> {
  // Uma transação fixa a conexão; o pool não pode trocar a sessão da tabela temporária.
  return orm.em.fork().transactional(async (em) => {
    await em.execute('create temporary table e2_money_round_trip (amount_minor bigint not null, currency text not null) on commit drop');
    const metadata = await em.execute<{ relpersistence: string }[]>(
      "select relpersistence from pg_class where oid = 'pg_temp.e2_money_round_trip'::regclass",
    );
    expect(metadata).toEqual([{ relpersistence: 't' }]);
    return run(em);
  });
}

describe('E2: Money / BIGINT no PostgreSQL real', () => {
  beforeAll(async () => {
    // Um único cliente também permite conferir a limpeza na mesma sessão após commit/rollback.
    orm = await MikroORM.init({ ...ormOptions(loadConfig(process.env)), pool: { min: 0, max: 1 } });
    tablesBefore = await publicTables();
  });

  afterAll(async () => {
    try {
      if (orm && tablesBefore) expect(await publicTables()).toEqual(tablesBefore);
    } finally {
      await orm?.close(true);
    }
  });

  test('round-trip exato de zero, negativos, moedas, centavos grandes e ambos os limites', async () => {
    const cases = [
      { minorUnits: 0n, currency: 'BRL', amount: '0.00' },
      { minorUnits: 2510n, currency: 'BRL', amount: '25.10' },
      { minorUnits: -1n, currency: 'BRL', amount: '-0.01' },
      { minorUnits: 123n, currency: 'USD', amount: '1.23' },
      { minorUnits: 9007199254740993n, currency: 'BRL', amount: '90071992547409.93' },
      { minorUnits: 9223372036854775807n, currency: 'BRL', amount: '92233720368547758.07' },
      { minorUnits: -9223372036854775808n, currency: 'BRL', amount: '-92233720368547758.08' },
    ];
    await withTemporaryTable(async (em) => {
      for (const { minorUnits, currency, amount } of cases) {
        const original = Money.rehydrate(minorUnits, currency);
        const [row] = await em.execute<{ amount_minor: unknown; amount_text: string; currency: string }[]>(
          'insert into e2_money_round_trip (amount_minor, currency) values (?, ?) returning amount_minor, amount_minor::text as amount_text, currency',
          [moneyToDatabase(original), currency],
        );
        if (!row) throw new Error('PostgreSQL não retornou a linha inserida');
        expect(['string', 'bigint']).toContain(typeof row.amount_minor);
        expect(row.amount_text).toBe(minorUnits.toString());
        expect(moneyFromDatabase(row.amount_minor, row.currency).toJSON()).toEqual({ amount, currency });
        expect(moneyFromDatabase(row.amount_text, row.currency).equals(original)).toBe(true);
      }
    });
  });

  test.each(['9223372036854775808', '-9223372036854775809'])('PostgreSQL rejeita overflow mesmo em SQL direto: %s', async (value) => {
    await expect(withTemporaryTable(async (em) => {
      await em.execute('insert into e2_money_round_trip (amount_minor, currency) values (?, ?)', [value, 'BRL']);
    })).rejects.toMatchObject({ code: '22003' });
  });

  test('commit/rollback removem a tabela temporária sem alterar tabelas permanentes', async () => {
    expect(await orm.em.fork().execute<{ relation: string | null }[]>(
      "select to_regclass('pg_temp.e2_money_round_trip')::text as relation",
    )).toEqual([{ relation: null }]);
    expect(await publicTables()).toEqual(tablesBefore);
  });
});
