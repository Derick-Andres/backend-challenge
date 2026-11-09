import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { assertReconciled, disposableDatabase, insertExternal } from './database-fixture.js';
import { startApi } from './api-fixture.js';

let db: Awaited<ReturnType<typeof disposableDatabase>>;
let apis: Awaited<ReturnType<typeof startApi>>[];
type Opened = { id: string; playerId: string };
type Command = { providerId: string; externalTransactionId: string; walletId: string; playerId: string; roundId: string; gameId: string; kind: string;
  money: { amount: string; currency: string }; referenceExternalTransactionId?: string };
async function open(): Promise<Opened> {
  const r = await apis[0]!.request('/wallets',{ playerId: crypto.randomUUID(), initialBalance: { amount: '100.00', currency: 'BRL' } });
  if (r.status!==201) throw new Error('Wallet não abriu'); return r.body as Opened;
}
function command(w: Opened, kind: string, amount = '10.00', reference?: Command): Command {
  return { providerId: 'provider', externalTransactionId: crypto.randomUUID(), playerId: w.playerId, walletId: w.id,
    roundId: 'round', gameId: 'game', kind, money: { amount, currency: 'BRL' },
    ...(reference ? { referenceExternalTransactionId: reference.externalTransactionId } : {}) };
}
function submit(input: Command, index = 0) { return apis[index]!.request('/wagering/transactions',input,{ 'idempotency-key': input.externalTransactionId }); }

describe('E8: LOSS e reversões no PostgreSQL, em múltiplos processos', () => {
  beforeAll(async () => { db = await disposableDatabase(); apis = await Promise.all(Array.from({ length: 3 },() => startApi(db.config))); });
  afterAll(async () => { await Promise.all(apis?.map((api) => api.close()) ?? []); await db?.close(); });
  test.each(['0.00','25.00'])('LOSS %s produz só Processed, sem ledger/version/BalanceChanged', async (amount) => {
    const w = await open(); const result = await submit(command(w,'LOSS',amount));
    expect(result.status).toBe(200);
    expect((await apis[0]!.request(`/wallets/${w.id}`)).body['version']).toBe(1);
    expect(await db.runtime.em.fork().execute('select id from wallet_ledger_entries where transaction_id=?',[result.body['transactionId']])).toEqual([]);
    expect(await db.runtime.em.fork().execute('select event_type from outbox_messages where aggregate_id=? or payload->\'data\'->>\'transactionId\'=?',[result.body['transactionId'],result.body['transactionId']]))
      .toEqual([{ event_type: 'WagerTransactionProcessed' }]);
    await assertReconciled(db.runtime.em.fork(),w.id);
  });
  test('REFUND e ROLLBACK da mesma BET uma vez cada: dois créditos permitidos', async () => {
    const w = await open(); const bet = command(w,'BET'); await submit(bet);
    const refund = await submit(command(w,'REFUND','10.00',bet),1);
    const rollback = await submit(command(w,'ROLLBACK','10.00',bet),2);
    expect(refund.status).toBe(200); expect(rollback.status).toBe(200);
    expect((await apis[0]!.request(`/wallets/${w.id}`)).body).toMatchObject({ balance: { amount: '110.00', currency: 'BRL' }, version: 4 });
    expect((await submit(command(w,'REFUND','10.00',bet))).body['failureCode']).toBe('ALREADY_REVERSED_BY_KIND');
    expect((await submit(command(w,'ROLLBACK','10.00',bet))).body['failureCode']).toBe('ALREADY_REVERSED_BY_KIND');
    await assertReconciled(db.runtime.em.fork(),w.id);
  });
  test('três REFUNDs concorrentes: um crédito, duas rejeições; unique continua no banco', async () => {
    const w = await open(); const bet = command(w,'BET'); await submit(bet);
    const results = await Promise.all(apis.map((_api,index) => submit(command(w,'REFUND','10.00',bet),index)));
    expect(results.filter((r) => r.status===200)).toHaveLength(1);
    expect(results.filter((r) => r.status===422 && r.body['failureCode']==='ALREADY_REVERSED_BY_KIND')).toHaveLength(2);
    expect((await apis[0]!.request(`/wallets/${w.id}`)).body).toMatchObject({ balance: { amount: '100.00', currency: 'BRL' }, version: 3 });
    await assertReconciled(db.runtime.em.fork(),w.id);
  });
  test('ROLLBACK inverte WIN/REFUND com débito; reversão de reversão não admitida', async () => {
    const w = await open(); const bet = command(w,'BET'); await submit(bet);
    const refund = command(w,'REFUND','10.00',bet); await submit(refund);
    const rollbackRefund = command(w,'ROLLBACK','10.00',refund);
    const reversed = await submit(rollbackRefund);
    expect(reversed.status).toBe(200);
    expect(await db.runtime.em.fork().execute('select direction from wallet_ledger_entries where transaction_id=?',[reversed.body['transactionId']])).toEqual([{ direction: 'DEBIT' }]);
    const win = command(w,'WIN','25.00'); await submit(win);
    expect((await submit(command(w,'ROLLBACK','25.00',win))).status).toBe(200);
    expect((await submit(command(w,'ROLLBACK','10.00',rollbackRefund))).body['failureCode']).toBe('REFERENCE_KIND_INVALID');
    await assertReconciled(db.runtime.em.fork(),w.id);
  });
  test('rollback sem saldo é rejeitado com código próprio; rejeição não consome direito de outra identidade', async () => {
    const w = await open(); const win = command(w,'WIN','100.00'); await submit(win);
    await submit(command(w,'BET','190.00'));
    const first = await submit(command(w,'ROLLBACK','100.00',win));
    expect(first.status).toBe(422); expect(first.body['failureCode']).toBe('REVERSAL_INSUFFICIENT_FUNDS');
    expect(await db.runtime.em.fork().execute('select id from wallet_ledger_entries where transaction_id=?',[first.body['transactionId']])).toEqual([]);
    await submit(command(w,'WIN','100.00'));
    expect((await submit(command(w,'ROLLBACK','100.00',win))).status).toBe(200);
    await assertReconciled(db.runtime.em.fork(),w.id);
  });
  test('valor, contexto, moeda, autorreferência e tipo inválidos não geram ledger', async () => {
    const w = await open(); const bet = command(w,'BET'); await submit(bet);
    const invalid: [Command,string][] = [
      [command(w,'REFUND','9.99',bet),'REFERENCE_AMOUNT_MISMATCH'],
      [{ ...command(w,'REFUND','10.00',bet), roundId: 'other' },'REFERENCE_CONTEXT_MISMATCH'],
      [{ ...command(w,'REFUND','10.00',bet), money: { amount: '10.00', currency: 'USD' } },'CURRENCY_MISMATCH'],
    ];
    const self = command(w,'REFUND'); self.referenceExternalTransactionId=self.externalTransactionId; invalid.push([self,'SELF_REFERENCE']);
    const win = command(w,'WIN'); await submit(win); invalid.push([command(w,'REFUND','10.00',win),'REFERENCE_KIND_INVALID']);
    for (const [input,code] of invalid) {
      const result = await submit(input); expect(result.status).toBe(422); expect(result.body['failureCode']).toBe(code);
      expect(await db.runtime.em.fork().execute('select id from wallet_ledger_entries where transaction_id=?',[result.body['transactionId']])).toEqual([]);
    }
    // gameId pode divergir; WIN referenciada pode ter prêmio diferente da BET.
    expect((await submit({ ...command(w,'WIN','50.00',bet), gameId: 'another-game' })).status).toBe(200);
    await assertReconciled(db.runtime.em.fork(),w.id);
  });
  test('referência rejeitada ou FAILED não é aguardada; OPENING não pode entrar externamente', async () => {
    const w = await open(); const rejected = command(w,'BET','101.00'); await submit(rejected);
    expect((await submit(command(w,'REFUND','101.00',rejected))).body['failureCode']).toBe('REFERENCE_NOT_PROCESSED');
    const failed = await db.runtime.em.fork().transactional((em) => insertExternal(em,w.id,{ player_id: w.playerId, status: 'FAILED', failure_code: 'PERMANENT_PROCESSING_FAILURE', completed_at: new Date() }));
    const input = command(w,'REFUND'); input.referenceExternalTransactionId=failed.external_transaction_id;
    expect((await submit(input)).body['failureCode']).toBe('REFERENCE_NOT_PROCESSED');
    expect((await submit(command(w,'OPENING'))).status).toBe(400);
    expect((await submit(command(w,'REFUND'))).body['code']).toBe('REFERENCE_REQUIRED');
    expect((await submit(command(w,'LOSS','0.00',rejected))).body['code']).toBe('REFERENCE_NOT_ALLOWED');
    await assertReconciled(db.runtime.em.fork(),w.id);
  });
});
