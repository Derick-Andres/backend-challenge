import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { WalletService } from '../../src/application/wallet-service.js';
import { WageringService } from '../../src/application/wagering-service.js';
import { PostgresFinancialDatabase } from '../../src/infrastructure/database/postgres-financial-database.js';
import { assertReconciled, disposableDatabase } from './database-fixture.js';
import { startApi } from './api-fixture.js';

let db: Awaited<ReturnType<typeof disposableDatabase>>;
let apis: Awaited<ReturnType<typeof startApi>>[];
type Opened = { id: string; playerId: string };
async function open(amount = '100.00'): Promise<Opened> {
  const response = await apis[0]!.request('/wallets',{ playerId: crypto.randomUUID(), initialBalance: { amount, currency: 'BRL' } });
  if (response.status!==201) throw new Error('Wallet não abriu');
  return response.body as Opened;
}
function command(wallet: Opened, amount = '80.00', kind = 'BET') {
  const id = crypto.randomUUID();
  return { providerId: 'provider', externalTransactionId: id, playerId: wallet.playerId, walletId: wallet.id,
    roundId: 'round', gameId: 'game', kind, money: { amount, currency: 'BRL' } };
}
async function submit(index: number, input: ReturnType<typeof command>, key = input.externalTransactionId) {
  return apis[index]!.request('/wagering/transactions',input,{ 'idempotency-key': key });
}
async function counts() {
  return db.runtime.em.fork().execute(`select
    (select count(*)::int from wallets) as wallets,(select count(*)::int from wager_transactions) as transactions,
    (select count(*)::int from wallet_ledger_entries) as ledger,(select count(*)::int from inbox_messages) as inbox,
    (select count(*)::int from outbox_messages) as outbox`);
}

describe('E6: lock por wallet e atomicidade em três processos reais', () => {
  beforeAll(async () => { db = await disposableDatabase(); apis = await Promise.all(Array.from({ length: 3 },() => startApi(db.config))); });
  afterAll(async () => { await Promise.all(apis?.map((api) => api.close()) ?? []); await db?.close(); });

  test('três APIs têm PIDs próprios e conexões independentes ao mesmo banco', async () => {
    expect(new Set(apis.map((api) => api.child.pid)).size).toBe(3);
    const results = await Promise.all(apis.map((api) => api.request('/health/ready')));
    expect(results.map((r) => r.status)).toEqual([200,200,200]);
  });
  test('duas BETs de 80 sobre saldo 100: um débito e uma rejeição; retry preserva resultado', async () => {
    const wallet = await open();
    const commands = [command(wallet),command(wallet)];
    const results = await Promise.all(commands.map((input,index) => submit(index,input)));
    expect(results.map((r) => r.status).sort()).toEqual([200,422]);
    expect(results.find((r) => r.status===422)?.body['failureCode']).toBe('INSUFFICIENT_FUNDS');
    expect((await apis[2]!.request(`/wallets/${wallet.id}`)).body['balance']).toEqual({ amount: '20.00', currency: 'BRL' });
    const replay = await submit(2,commands[0]!);
    expect(replay.body).toEqual({ ...results[0]!.body, idempotentReplay: true });
    expect(await db.runtime.em.fork().execute("select count(*)::int as count from wallet_ledger_entries where wallet_id=? and direction='DEBIT'",[wallet.id]))
      .toEqual([{ count: 1 }]);
    await assertReconciled(db.runtime.em.fork(),wallet.id);
  });
  test('três processos disputando mesma wallet não perdem updates', async () => {
    const wallet = await open();
    const results = await Promise.all(apis.map((_api,index) => submit(index,command(wallet))));
    expect(results.filter((r) => r.status===200)).toHaveLength(1);
    expect(results.filter((r) => r.status===422)).toHaveLength(2);
    expect((await apis[0]!.request(`/wallets/${wallet.id}`)).body['version']).toBe(2);
    await assertReconciled(db.runtime.em.fork(),wallet.id);
  });
  test('wallet B conclui enquanto A está bloqueada: evidência por pg_blocking_pids, sem limite de latência frágil', async () => {
    const a = await open(); const b = await open();
    let release!: () => void; let locked!: () => void;
    const ready = new Promise<void>((resolve) => { locked=resolve; });
    const gate = new Promise<void>((resolve) => { release=resolve; });
    const holder = db.runtime.em.fork().transactional(async (em) => { await em.execute('select id from wallets where id=? for update',[a.id]); locked(); await gate; });
    await ready;
    let aDone = false;
    const requestA = submit(0,command(a,'1.00')).then((result) => { aDone=true; return result; });
    try {
      const deadline = Date.now()+5000;
      let observed = false;
      while (Date.now()<deadline) {
        const [row] = await db.runtime.em.fork().execute<{ blocked: boolean }[]>(`select exists(select 1 from pg_stat_activity
          where application_name=? and cardinality(pg_blocking_pids(pid))>0) as blocked`,[`backend-challenge:${apis[0]!.child.pid}`]);
        if (row?.blocked) { observed=true; break; }
        await Bun.sleep(20);
      }
      expect(observed).toBe(true);
      expect((await submit(1,command(b,'1.00'))).status).toBe(200);
      expect(aDone).toBe(false);
    } finally { release(); await holder; }
    expect((await requestA).status).toBe(200);
    await assertReconciled(db.runtime.em.fork(),a.id); await assertReconciled(db.runtime.em.fork(),b.id);
  });
  test('WIN credita exatamente, moeda/player divergentes e overflow de saldo rejeitam sem ledger', async () => {
    const wallet = await open();
    expect((await submit(0,command(wallet,'25.00','WIN'))).status).toBe(200);
    expect((await apis[0]!.request(`/wallets/${wallet.id}`)).body['balance']).toEqual({ amount: '125.00', currency: 'BRL' });
    const currency = command(wallet,'1.00','WIN'); currency.money.currency='USD';
    expect((await submit(1,currency)).body['failureCode']).toBe('CURRENCY_MISMATCH');
    const player = command(wallet,'1.00','WIN'); player.playerId='other';
    expect((await submit(2,player)).body['failureCode']).toBe('WALLET_PLAYER_MISMATCH');
    const max = await open('92233720368547758.07');
    const overflow = await submit(0,command(max,'0.01','WIN'));
    expect(overflow.status).toBe(422);
    expect(overflow.body['failureCode']).toBe('BALANCE_LIMIT_EXCEEDED');
    await assertReconciled(db.runtime.em.fork(),wallet.id); await assertReconciled(db.runtime.em.fork(),max.id);
  });
  test.each(['transaction','wallet','ledger','outbox'])('falha após %s reverte todos os estados e eventos da operação', async (step) => {
    const service = new WalletService(new PostgresFinancialDatabase(db.runtime));
    const wallet = await service.open({ playerId: crypto.randomUUID(), initialBalance: { amount: '100.00', currency: 'BRL' } });
    const before = await counts();
    const wagering = new WageringService(new PostgresFinancialDatabase(db.runtime,{ afterWrite: async (written) => { if (written===step) throw new Error('injected'); } }));
    await expect(wagering.process(command(wallet),crypto.randomUUID())).rejects.toThrow('injected');
    expect(await counts()).toEqual(before);
    await assertReconciled(db.runtime.em.fork(),wallet.id);
    expect((await apis[0]!.request(`/wallets/${wallet.id}`)).body['version']).toBe(1);
  });
  test('erro diferido no COMMIT não retorna sucesso e reverte até os eventos já inseridos', async () => {
    const wallet = await open();
    const before = await counts();
    let altered = false;
    const wagering = new WageringService(new PostgresFinancialDatabase(db.runtime,{ afterWrite: async (step,em) => {
      if (step==='outbox' && !altered) { altered=true; await em.execute('update wallets set balance_minor=balance_minor+1,version=version+1 where id=?',[wallet.id]); }
    } }));
    await expect(wagering.process(command(wallet),crypto.randomUUID())).rejects.toMatchObject({ code: '23514' });
    expect(await counts()).toEqual(before);
    await assertReconciled(db.runtime.em.fork(),wallet.id);
  });
});
