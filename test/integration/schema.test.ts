import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { assertReconciled, disposableDatabase, insertExternal, insertOpening } from './database-fixture.js';
import { grantRuntimeAccess } from '../../src/infrastructure/database/runtime-role.js';

let db: Awaited<ReturnType<typeof disposableDatabase>>;
let opening: Awaited<ReturnType<typeof insertOpening>>;

describe('E4: schema financeiro no PostgreSQL real com papel runtime', () => {
  beforeAll(async () => { db = await disposableDatabase(); });
  afterAll(async () => { await db?.close(); });

  test('migration up/down/up é reversível; cria cinco tabelas centrais', async () => {
    await db.owner.migrator.down();
    expect(await db.owner.em.fork().execute("select tablename from pg_tables where schemaname='public' and tablename='wallets'")).toEqual([]);
    await db.owner.migrator.up();
    await grantRuntimeAccess(db.owner.em.fork(), db.config.PGUSER);
    const rows = await db.runtime.em.fork().execute<{ tablename: string }[]>("select tablename from pg_tables where schemaname='public' and tablename<>'mikro_orm_migrations'");
    expect(rows).toHaveLength(5);
  });
  test('runtime não é owner/superuser, não cria tabelas nem desabilita triggers', async () => {
    expect(await db.runtime.em.fork().execute('select rolsuper,rolcreatedb,rolcreaterole from pg_roles where rolname=current_user'))
      .toEqual([{ rolsuper: false, rolcreatedb: false, rolcreaterole: false }]);
    await expect(db.runtime.em.fork().execute('create table unauthorized(id int)')).rejects.toMatchObject({ code: '42501' });
    await expect(db.runtime.em.fork().execute('alter table wallets disable trigger all')).rejects.toMatchObject({ code: '42501' });
  });
  test('abertura positiva confirma OPENING/CREDIT/version1; zero não exige ledger', async () => {
    opening = await db.runtime.em.fork().transactional((em) => insertOpening(em));
    const zero = await db.runtime.em.fork().transactional((em) => insertOpening(em, '0'));
    await assertReconciled(db.runtime.em.fork(), opening.walletId);
    await assertReconciled(db.runtime.em.fork(), zero.walletId);
    expect(await db.runtime.em.fork().execute('select version from wallets where id=?', [opening.walletId])).toEqual([{ version: 1 }]);
  });
  test('unique player/moeda e saldo não negativo existem no banco', async () => {
    await expect(db.runtime.em.fork().execute('insert into wallets values(?,?,?,0,1,now(),now())', [crypto.randomUUID(), opening.walletId, 'BRL']))
      .rejects.toMatchObject({ code: '23505' });
    await expect(db.runtime.em.fork().execute('insert into wallets values(?,?,?,-1,1,now(),now())', [crypto.randomUUID(), 'negative', 'BRL']))
      .rejects.toMatchObject({ code: '23514' });
  });
  test('saldo inicial positivo sem OPENING/ledger falha no COMMIT, não na escrita', async () => {
    let inserted = false;
    await expect(db.runtime.em.fork().transactional(async (em) => {
      await em.execute('insert into wallets values(?,?,?,1,1,now(),now())', [crypto.randomUUID(), 'orphan', 'BRL']);
      inserted = true;
    })).rejects.toMatchObject({ code: '23514' });
    expect(inserted).toBe(true);
    expect(await db.runtime.em.fork().execute("select id from wallets where player_id='orphan'")).toEqual([]);
  });
  test('update de saldo sem ledger correspondente é desfeito no COMMIT', async () => {
    await expect(db.runtime.em.fork().transactional(async (em) => {
      await em.execute('update wallets set balance_minor=9000,version=2 where id=?', [opening.walletId]);
    })).rejects.toMatchObject({ code: '23514' });
    await assertReconciled(db.runtime.em.fork(), opening.walletId);
  });
  test.each([
    'update wallets set version=version+1 where id=?',
    'update wallets set balance_minor=balance_minor-1 where id=?',
    "update wallets set currency='USD' where id=?",
  ])('guard de versão e identidade: %s', async (sql) => {
    await expect(db.runtime.em.fork().execute(sql, [opening.walletId])).rejects.toMatchObject({ code: '23514' });
  });
  test.each(['update wallet_ledger_entries set amount_minor=amount_minor where id=?', 'delete from wallet_ledger_entries where id=?'])('runtime não pode reescrever ledger: %s', async (sql) => {
    await expect(db.runtime.em.fork().execute(sql, [opening.entryId])).rejects.toMatchObject({ code: '42501' });
  });
  test('triggers de imutabilidade também rejeitam UPDATE/DELETE/TRUNCATE pelo owner', async () => {
    for (const sql of [
      'update wallet_ledger_entries set amount_minor=amount_minor', 'delete from wallet_ledger_entries', 'truncate wallet_ledger_entries',
      "update wager_transactions set status='PENDING'", 'delete from wager_transactions',
    ]) await expect(db.owner.em.fork().execute(sql)).rejects.toMatchObject({ code: '23514' });
  });
  test('PROCESSSED financeiro sem ledger e ledger com estado não financeiro são recusados', async () => {
    await expect(db.runtime.em.fork().transactional((em) => insertExternal(em, opening.walletId, { status: 'PROCESSED', processed_at: new Date(), completed_at: new Date() })))
      .rejects.toMatchObject({ code: '23514' });
    await expect(db.runtime.em.fork().transactional(async (em) => {
      const t = await insertExternal(em, opening.walletId, { kind: 'LOSS', status: 'PROCESSED', processed_at: new Date(), completed_at: new Date() });
      await em.execute("insert into wallet_ledger_entries values(?,?,?,2,'DEBIT',1000,'BRL',10000,9000,now())", [crypto.randomUUID(), opening.walletId, t.id]);
      await em.execute('update wallets set balance_minor=9000,version=2 where id=?', [opening.walletId]);
    })).rejects.toMatchObject({ code: '23514' });
  });
  test('ledger com aritmética ou moeda divergente e referência inexistente são recusados', async () => {
    await expect(db.runtime.em.fork().transactional(async (em) => {
      const t = await insertExternal(em, opening.walletId);
      await em.execute("insert into wallet_ledger_entries values(?,?,?,2,'DEBIT',1000,'BRL',10000,9001,now())", [crypto.randomUUID(), opening.walletId, t.id]);
    })).rejects.toMatchObject({ code: '23514' });
    await expect(db.runtime.em.fork().transactional(async (em) => {
      const t = await insertExternal(em, opening.walletId, { status: 'PROCESSED', processed_at: new Date(), completed_at: new Date() });
      await em.execute("insert into wallet_ledger_entries values(?,?,?,2,'DEBIT',1000,'USD',10000,9000,now())", [crypto.randomUUID(), opening.walletId, t.id]);
      await em.execute('update wallets set balance_minor=9000,version=2 where id=?', [opening.walletId]);
    })).rejects.toMatchObject({ code: '23514' });
    await expect(db.runtime.em.fork().transactional((em) => insertExternal(em, opening.walletId, { kind: 'WIN', reference_external_transaction_id: 'missing', reference_transaction_id: 'missing' })))
      .rejects.toMatchObject({ code: '23503' });
  });
  test('mesma key e identidade externa são únicas independentemente de memória', async () => {
    const first = await db.runtime.em.fork().transactional((em) => insertExternal(em, opening.walletId));
    await expect(db.runtime.em.fork().transactional((em) => insertExternal(em, opening.walletId, { idempotency_key: first.idempotency_key }))).rejects.toMatchObject({ code: '23505' });
    await expect(db.runtime.em.fork().transactional((em) => insertExternal(em, opening.walletId, { external_transaction_id: first.external_transaction_id }))).rejects.toMatchObject({ code: '23505' });
  });
  test('primeira resposta/HTTP são preservados e inbox/outbox protegem identidade/envelope', async () => {
    const t = await db.runtime.em.fork().transactional((em) => insertExternal(em, opening.walletId, { first_response: '{"status":"PENDING"}', first_http_status: 202 }));
    await expect(db.runtime.em.fork().execute('update wager_transactions set first_http_status=200 where id=?', [t.id])).rejects.toMatchObject({ code: '23514' });
    await db.runtime.em.fork().execute("insert into inbox_messages values('consumer','message','hash',now(),now(),'ACK')");
    await expect(db.runtime.em.fork().execute("update inbox_messages set payload_hash='other'")).rejects.toMatchObject({ code: '23514' });
    const id = crypto.randomUUID();
    await db.runtime.em.fork().execute('insert into outbox_messages values(?,?,?,?::jsonb,now(),0,now(),null)', [id, 'aggregate', 'Type', JSON.stringify({ eventId: id, aggregateId: 'aggregate', eventType: 'Type' })]);
    await expect(db.runtime.em.fork().execute("update outbox_messages set payload='{}'::jsonb")).rejects.toMatchObject({ code: '23514' });
  });
  test('reversão única por referência + tipo e contexto/valor/direção verificados no SQL', async () => {
    const w = await db.runtime.em.fork().transactional((em) => insertOpening(em));
    const bet = await db.runtime.em.fork().transactional(async (em) => {
      const t = await insertExternal(em, w.walletId, { status: 'PROCESSED', processed_at: new Date(), completed_at: new Date() });
      await em.execute('update wallets set balance_minor=9000,version=2 where id=?', [w.walletId]);
      await em.execute("insert into wallet_ledger_entries values(?,?,?,2,'DEBIT',1000,'BRL',10000,9000,now())", [crypto.randomUUID(), w.walletId, t.id]);
      return t;
    });
    const reverse = (kind: string, amount: string, before: string, after: string, version: number, extra: Record<string, unknown> = {}) => db.runtime.em.fork().transactional(async (em) => {
      const t = await insertExternal(em, w.walletId, { kind, amount_minor: amount, status: 'PROCESSED', processed_at: new Date(), completed_at: new Date(), reference_transaction_id: bet.id, reference_external_transaction_id: bet.external_transaction_id, ...extra });
      await em.execute('update wallets set balance_minor=?,version=? where id=?', [after, version, w.walletId]);
      await em.execute("insert into wallet_ledger_entries values(?,?,?,?,'CREDIT',?,'BRL',?,?,now())", [crypto.randomUUID(), w.walletId, t.id, version, amount, before, after]);
    });
    await expect(reverse('REFUND','999','9000','9999',3)).rejects.toMatchObject({ code: '23514' });
    await expect(reverse('REFUND','1000','9000','10000',3,{ round_id: 'other' })).rejects.toMatchObject({ code: '23514' });
    await reverse('REFUND','1000','9000','10000',3);
    await expect(reverse('REFUND','1000','10000','11000',4)).rejects.toMatchObject({ code: '23505' });
    await reverse('ROLLBACK','1000','10000','11000',4);
    await assertReconciled(db.runtime.em.fork(), w.walletId);
    expect(await db.runtime.em.fork().execute('select balance_minor::text as balance,version from wallets where id=?', [w.walletId])).toEqual([{ balance: '11000', version: 4 }]);
  });
  test.each([1, 2, 3, 4, 5])('falha após escrita %i desfaz wallet/transação/ledger/inbox/outbox', async (failAt) => {
    const id = crypto.randomUUID();
    await expect(db.runtime.em.fork().transactional(async (em) => {
      let step = 0;
      const checkpoint = () => { if (++step === failAt) throw new Error('injected'); };
      await em.execute('insert into wallets values(?,?,?,100,1,now(),now())', [id, id, 'BRL']); checkpoint();
      await em.execute("insert into wager_transactions(id,wallet_id,player_id,kind,amount_minor,currency,status,created_at,processed_at,completed_at) values(?,?,?,'OPENING',100,'BRL','PROCESSED',now(),now(),now())", [id, id, id]); checkpoint();
      await em.execute("insert into wallet_ledger_entries values(?,?,?,1,'CREDIT',100,'BRL',0,100,now())", [id, id, id]); checkpoint();
      await em.execute("insert into inbox_messages values('atomic',?,'hash',now(),now(),'ACK')", [id]); checkpoint();
      await em.execute('insert into outbox_messages values(?,?,?,?::jsonb,now(),0,now(),null)', [id, id, 'Type', JSON.stringify({ eventId: id, aggregateId: id, eventType: 'Type' })]); checkpoint();
    })).rejects.toThrow('injected');
    for (const [table, column] of [['wallets','id'],['wager_transactions','id'],['wallet_ledger_entries','id'],['inbox_messages','message_id'],['outbox_messages','id']]) {
      expect(await db.runtime.em.fork().execute(`select 1 from ${table} where ${column}=?`, [id])).toEqual([]);
    }
  });
});
