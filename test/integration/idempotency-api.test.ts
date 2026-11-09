import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { assertReconciled, disposableDatabase } from './database-fixture.js';
import { startApi } from './api-fixture.js';
import { PostgresFinancialDatabase } from '../../src/infrastructure/database/postgres-financial-database.js';
import { WageringService } from '../../src/application/wagering-service.js';

let db: Awaited<ReturnType<typeof disposableDatabase>>;
let apis: Awaited<ReturnType<typeof startApi>>[];
type Opened = { id: string; playerId: string };
async function open(): Promise<Opened> {
  const r = await apis[0]!.request('/wallets',{ playerId: crypto.randomUUID(), initialBalance: { amount: '100.00', currency: 'BRL' } });
  if (r.status!==201) throw new Error('Wallet não abriu'); return r.body as Opened;
}
function command(w: Opened, kind = 'BET', amount = '10.00') {
  return { providerId: 'provider', externalTransactionId: crypto.randomUUID(), playerId: w.playerId, walletId: w.id,
    roundId: 'round', gameId: 'game', kind, money: { amount, currency: 'BRL' } };
}
function submit(index: number, input: ReturnType<typeof command>, key = input.externalTransactionId) {
  return apis[index]!.request('/wagering/transactions',input,{ 'idempotency-key': key });
}

describe('E7: idempotência durável e resultados históricos em três APIs', () => {
  beforeAll(async () => { db = await disposableDatabase(); apis = await Promise.all(Array.from({ length: 3 },() => startApi(db.config))); });
  afterAll(async () => { await Promise.all(apis?.map((api) => api.close()) ?? []); await db?.close(); });
  test('mesma BET 50 vezes em paralelo gera um débito, uma transação e um par de eventos', async () => {
    const w = await open(); const input = command(w);
    const results = await Promise.all(Array.from({ length: 50 },(_,i) => submit(i%3,input)));
    expect(results.every((r) => r.status===200)).toBe(true);
    expect(results.filter((r) => r.body['idempotentReplay']===false)).toHaveLength(1);
    expect(new Set(results.map((r) => r.body['transactionId'])).size).toBe(1);
    const original = results.find((r) => r.body['idempotentReplay']===false)!;
    for (const r of results) expect(r.body).toEqual({ ...original.body, idempotentReplay: r.body['idempotentReplay'] });
    expect(await db.runtime.em.fork().execute("select count(*)::int as count from wallet_ledger_entries where wallet_id=? and direction='DEBIT'",[w.id])).toEqual([{ count: 1 }]);
    expect(await db.runtime.em.fork().execute('select count(*)::int as count from outbox_messages where aggregate_id=? or payload->\'data\'->>\'transactionId\'=?',[original.body['transactionId'],original.body['transactionId']])).toEqual([{ count: 2 }]);
    await assertReconciled(db.runtime.em.fork(),w.id);
  });
  test('replay preserva saldo original após outros créditos e GET expõe resultado histórico', async () => {
    const w = await open(); const input = command(w);
    const original = await submit(0,input);
    await submit(1,command(w,'WIN','50.00'));
    const reversedOrder = Object.fromEntries(Object.entries(input).reverse()) as ReturnType<typeof command>;
    const replay = await submit(2,reversedOrder);
    expect(replay).toEqual({ status: original.status, body: { ...original.body, idempotentReplay: true } });
    expect(replay.body['balance']).toEqual({ amount: '90.00', currency: 'BRL' });
    const read = await apis[1]!.request(`/wagering/transactions/${original.body['transactionId']}`);
    const byExternal = await apis[2]!.request(`/providers/provider/wagering/transactions/${input.externalTransactionId}`);
    expect(read.status).toBe(200); expect(byExternal.body).toEqual(read.body);
    expect(read.body['terminalResult']).toEqual({ httpStatus: 200, body: original.body });
    expect((await apis[0]!.request(`/wallets/${w.id}`)).body['balance']).toEqual({ amount: '140.00', currency: 'BRL' });
    await assertReconciled(db.runtime.em.fork(),w.id);
  });
  test('commit entre consulta rápida da key e lock deve ser replay, com barreira real', async () => {
    const w = await open(); const input = command(w);
    let release!: () => void; let entered!: () => void; let first = true;
    const waiting = new Promise<void>((resolve) => { entered=resolve; });
    const gate = new Promise<void>((resolve) => { release=resolve; });
    const service = new WageringService(new PostgresFinancialDatabase(db.runtime,{ afterTransactionKeyRead: async (key,found) => {
      if (key===input.externalTransactionId && !found && first) { first=false; entered(); await gate; }
    } }));
    const delayed = service.process(input,input.externalTransactionId);
    await waiting;
    let original;
    try { original = await submit(1,input); expect(original.status).toBe(200); }
    finally { release(); }
    const replay = await delayed;
    expect(replay.status).toBe(original.status);
    const replayBody: Record<string,unknown> = replay.body;
    expect(replayBody).toEqual({ ...original.body,idempotentReplay: true });
    await assertReconciled(db.runtime.em.fork(),w.id);
  });
  test('mesma key com payload divergente e identidade externa com outra key são conflitos distintos', async () => {
    const w = await open(); const input = command(w); await submit(0,input);
    expect(await submit(1,{ ...input, roundId: 'different' })).toEqual({ status: 409, body: { code: 'IDEMPOTENCY_CONFLICT' } });
    expect(await submit(2,input,crypto.randomUUID())).toEqual({ status: 409, body: { code: 'EXTERNAL_TRANSACTION_ID_CONFLICT' } });
    const invalidWallet = { ...input, walletId: 'missing' };
    expect((await submit(1,invalidWallet)).status).toBe(409);
    await assertReconciled(db.runtime.em.fork(),w.id);
  });
  test('key global em wallets diferentes: unique entre processos permite um efeito', async () => {
    const a = await open(); const b = await open(); const key = crypto.randomUUID();
    const results = await Promise.all([submit(0,command(a),key),submit(1,command(b),key)]);
    expect(results.map((r) => r.status).sort()).toEqual([200,409]);
    expect(results.find((r) => r.status===409)?.body['code']).toBe('IDEMPOTENCY_CONFLICT');
    const [row] = await db.runtime.em.fork().execute<{ total: string }[]>('select sum(balance_minor)::text as total from wallets where id in (?,?)',[a.id,b.id]);
    expect(row?.total).toBe('19000');
    await assertReconciled(db.runtime.em.fork(),a.id); await assertReconciled(db.runtime.em.fork(),b.id);
  });
  test('mesma identidade externa com keys/wallets diferentes também permite um efeito', async () => {
    const a = await open(); const b = await open(); const externalTransactionId = crypto.randomUUID();
    const results = await Promise.all([submit(0,{ ...command(a),externalTransactionId },crypto.randomUUID()),submit(2,{ ...command(b),externalTransactionId },crypto.randomUUID())]);
    expect(results.map((r) => r.status).sort()).toEqual([200,409]);
    expect(results.find((r) => r.status===409)?.body['code']).toBe('EXTERNAL_TRANSACTION_ID_CONFLICT');
    await assertReconciled(db.runtime.em.fork(),a.id); await assertReconciled(db.runtime.em.fork(),b.id);
  });
  test('primeiro 202 permanece 202 depois de conclusão persistida e reinício da API', async () => {
    const w = await open(); const referenceId = crypto.randomUUID();
    const input = { ...command(w,'WIN','5.00'), referenceExternalTransactionId: referenceId };
    const original = await submit(0,input);
    expect(original.status).toBe(202);
    const bet = await submit(1,{ ...command(w), externalTransactionId: referenceId });
    expect(bet.status).toBe(200);
    // Fixture de evolução persistida: testa a imutabilidade do aceite; o worker real será exercitado em E9.
    const terminal = { ...original.body, status: 'PROCESSED', balance: { amount: '95.00', currency: 'BRL' } };
    await db.runtime.em.fork().transactional(async (em) => {
      await em.execute('select id from wallets where id=? for update',[w.id]);
      await em.execute("update wager_transactions set status='PROCESSED',reference_transaction_id=?,processed_at=now(),completed_at=now(),terminal_response=?::jsonb where id=?",[bet.body['transactionId'],JSON.stringify({ status: 200, body: terminal }),original.body['transactionId']]);
      await em.execute('update wallets set balance_minor=9500,version=3 where id=?',[w.id]);
      await em.execute("insert into wallet_ledger_entries values(?,?,?,3,'CREDIT',500,'BRL',9000,9500,now())",[crypto.randomUUID(),w.id,original.body['transactionId']]);
    });
    await apis[0]!.close(); apis[0] = await startApi(db.config);
    expect(await submit(0,input)).toEqual({ status: 202, body: { ...original.body, idempotentReplay: true } });
    const read = await apis[0]!.request(`/wagering/transactions/${original.body['transactionId']}`);
    expect(read.body['status']).toBe('PROCESSED');
    expect(read.body['acceptanceResult']).toEqual({ httpStatus: 202, body: original.body });
    expect(read.body['terminalResult']).toEqual({ httpStatus: 200, body: terminal });
    await assertReconciled(db.runtime.em.fork(),w.id);
  });
  test('rejeição também tem replay original; consultas ausentes são 404 e header é obrigatório', async () => {
    const w = await open(); const input = command(w,'BET','101.00');
    const original = await submit(0,input);
    expect(original.status).toBe(422);
    await submit(1,command(w,'WIN','100.00'));
    expect(await submit(2,input)).toEqual({ status: 422, body: { ...original.body, idempotentReplay: true } });
    expect((await apis[0]!.request('/wagering/transactions',command(w))).body['code']).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect((await apis[0]!.request('/wagering/transactions/missing')).status).toBe(404);
    expect((await apis[0]!.request('/providers/provider/wagering/transactions/missing')).status).toBe(404);
    await assertReconciled(db.runtime.em.fork(),w.id);
  });
});
