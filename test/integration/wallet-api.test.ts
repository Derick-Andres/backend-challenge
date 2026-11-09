import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { WalletService } from '../../src/application/wallet-service.js';
import { PostgresFinancialDatabase } from '../../src/infrastructure/database/postgres-financial-database.js';
import { assertReconciled, disposableDatabase, insertExternal } from './database-fixture.js';
import { startApi } from './api-fixture.js';

let db: Awaited<ReturnType<typeof disposableDatabase>>;
let api: Awaited<ReturnType<typeof startApi>>;
const command = (playerId = crypto.randomUUID(), amount = '100.00') => ({ playerId, initialBalance: { amount, currency: 'BRL' } });

async function rawBet(walletId: string) {
  await db.runtime.em.fork().transactional(async (em) => {
    const [w] = await em.execute<{ balance: string; version: number }[]>('select balance_minor::text as balance,version from wallets where id=? for update', [walletId]);
    if (!w) throw new Error('Missing wallet');
    const after = (BigInt(w.balance)-100n).toString();
    const t = await insertExternal(em,walletId,{ amount_minor: '100', status: 'PROCESSED', processed_at: new Date(), completed_at: new Date() });
    // Player da fixture externa precisa corresponder à wallet criada pela API.
    await em.execute('update wallets set balance_minor=?,version=version+1 where id=?', [after,walletId]);
    await em.execute("insert into wallet_ledger_entries values(?,?,?,?,'DEBIT',100,'BRL',?,?,now())", [crypto.randomUUID(),walletId,t.id,w.version+1,w.balance,after]);
  });
}

describe('E5: wallet HTTP + PostgreSQL reais', () => {
  beforeAll(async () => { db = await disposableDatabase(); api = await startApi(db.config); });
  afterAll(async () => { await api?.close(); await db?.close(); });
  test('abertura positiva confirma saldo, OPENING, ledger e dois eventos; GET retorna estado', async () => {
    const response = await api.request('/wallets',command());
    expect(response.status).toBe(201);
    expect(response.body['balance']).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(response.body['version']).toBe(1);
    const id = response.body['id'] as string;
    expect((await api.request(`/wallets/${id}`)).body).toEqual(response.body);
    const transactions = await db.runtime.em.fork().execute('select kind,status from wager_transactions where wallet_id=?', [id]);
    expect(transactions).toEqual([{ kind: 'OPENING', status: 'PROCESSED' }]);
    expect(await db.runtime.em.fork().execute('select event_type from outbox_messages where aggregate_id in (?,(select id from wager_transactions where wallet_id=?)) order by event_type', [id,id]))
      .toEqual([{ event_type: 'WagerTransactionProcessed' },{ event_type: 'WalletBalanceChanged' }]);
    await assertReconciled(db.runtime.em.fork(),id);
  });
  test('abertura zero não fabrica OPENING, ledger ou evento de saldo', async () => {
    const response = await api.request('/wallets',command(crypto.randomUUID(),'0.00'));
    expect(response.status).toBe(201);
    const id = response.body['id'] as string;
    expect(await db.runtime.em.fork().execute('select id from wager_transactions where wallet_id=?', [id])).toEqual([]);
    expect((await api.request(`/wallets/${id}/ledger`)).body).toEqual({ items: [], nextCursor: null });
    await assertReconciled(db.runtime.em.fork(),id);
  });
  test('abertura e leitura pelo mapeamento ORM preservam centavos além de MAX_SAFE_INTEGER', async () => {
    const response = await api.request('/wallets',command(crypto.randomUUID(),'90071992547409.93'));
    expect(response.status).toBe(201);
    expect((await api.request(`/wallets/${response.body['id']}`)).body['balance']).toEqual({ amount: '90071992547409.93', currency: 'BRL' });
    await assertReconciled(db.runtime.em.fork(),response.body['id'] as string);
  });
  test('dez aberturas concorrentes para mesmo player/moeda produzem um sucesso e nove conflitos', async () => {
    const input = command();
    const results = await Promise.all(Array.from({ length: 10 },() => api.request('/wallets',input)));
    expect(results.filter((r) => r.status===201)).toHaveLength(1);
    expect(results.filter((r) => r.status===409 && r.body['code']==='WALLET_ALREADY_EXISTS')).toHaveLength(9);
    const id = results.find((r) => r.status===201)?.body['id'] as string;
    expect(await db.runtime.em.fork().execute('select count(*)::int as count from wallet_ledger_entries where wallet_id=?',[id])).toEqual([{ count: 1 }]);
    await assertReconciled(db.runtime.em.fork(),id);
  });
  test.each(['-1.00','1.001','1e2','NaN','Infinity',100])('contrato rejeita dinheiro inválido %p', async (amount) => {
    const input = command();
    expect((await api.request('/wallets',{ ...input, initialBalance: { amount, currency: 'BRL' } })).status).toBe(400);
  });
  test('overflow inicial é erro de entrada, não armazenamento arredondado', async () => {
    const response = await api.request('/wallets',command(crypto.randomUUID(),'92233720368547758.08'));
    expect(response).toEqual({ status: 400, body: { code: 'AMOUNT_OUT_OF_RANGE' } });
  });
  test('ausência e paginação inválida são distinguíveis', async () => {
    expect((await api.request('/wallets/missing')).status).toBe(404);
    const response = await api.request('/wallets',command());
    const id = response.body['id'];
    expect((await api.request(`/wallets/${id}/ledger?limit=0`)).status).toBe(400);
    expect((await api.request(`/wallets/${id}/ledger?limit=101`)).status).toBe(400);
    expect((await api.request(`/wallets/${id}/ledger?cursor=invalid`)).status).toBe(400);
  });
  test('cursor conserva corte da primeira página sob inserções posteriores e valida wallet', async () => {
    // O player igual ao id permite usar a fixture SQL direta sem um endpoint de operações antecipado.
    const id = crypto.randomUUID();
    await db.runtime.em.fork().transactional(async (em) => {
      const { insertOpening } = await import('./database-fixture.js');
      await insertOpening(em,'10000',id);
    });
    await rawBet(id);
    const first = await api.request(`/wallets/${id}/ledger?limit=1`);
    expect((first.body['items'] as unknown[])).toHaveLength(1);
    const cursor = first.body['nextCursor'] as string;
    expect(typeof cursor).toBe('string');
    await rawBet(id);
    const second = await api.request(`/wallets/${id}/ledger?limit=1&cursor=${cursor}`);
    expect((second.body['items'] as { walletVersion: number }[]).map((item) => item.walletVersion)).toEqual([2]);
    expect(second.body['nextCursor']).toBeNull();
    expect((await api.request(`/wallets/${id}/ledger`)).body['items']).toHaveLength(3);
    const other = await api.request('/wallets',command());
    expect((await api.request(`/wallets/${other.body['id']}/ledger?cursor=${cursor}`)).status).toBe(400);
    await assertReconciled(db.runtime.em.fork(),id);
  });
  test.each(['wallet','transaction','ledger','outbox'])('falha depois de %s desfaz toda a abertura no mesmo EM', async (step) => {
    const input = command();
    const service = new WalletService(new PostgresFinancialDatabase(db.runtime,{ afterWrite: async (written) => { if (written===step) throw new Error('injected'); } }));
    await expect(service.open(input)).rejects.toThrow('injected');
    expect(await db.runtime.em.fork().execute('select id from wallets where player_id=?',[input.playerId])).toEqual([]);
  });
});
