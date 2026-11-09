import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { WalletService } from '../../src/application/wallet-service.js';
import { WageringService } from '../../src/application/wagering-service.js';
import { PostgresFinancialDatabase } from '../../src/infrastructure/database/postgres-financial-database.js';
import { assertReconciled, disposableDatabase, insertExternal } from './database-fixture.js';
import { startApi } from './api-fixture.js';
import { startWorker, waitFor } from './worker-fixture.js';
import { FailureCode } from '../../src/domain/errors.js';
import { WagerTransactionStatus } from '../../src/domain/wager-transaction.js';

let db: Awaited<ReturnType<typeof disposableDatabase>>;
let api: Awaited<ReturnType<typeof startApi>>;
let workers: Awaited<ReturnType<typeof startWorker>>[] = [];
type Opened = { id: string; playerId: string };
const workerEnv = { WORKER_ROLES: 'references',WORKER_POLL_MS: '20', REFERENCE_BASE_DELAY_MS: '20', REFERENCE_MAX_DELAY_MS: '100' };
const inputFor = (w: Opened,kind: string,amount = '10.00',reference?: string) => ({ providerId: 'provider',externalTransactionId: crypto.randomUUID(),
  walletId: w.id,playerId: w.playerId,roundId: 'round',gameId: 'game',kind,money: { amount,currency: 'BRL' },
  ...(reference===undefined ? {} : { referenceExternalTransactionId: reference }) });
const submit = (input: ReturnType<typeof inputFor>) => api.request('/wagering/transactions',input,{ 'idempotency-key': input.externalTransactionId });
async function open(): Promise<Opened> {
  const response = await api.request('/wallets',{ playerId: crypto.randomUUID(),initialBalance: { amount: '100.00',currency: 'BRL' } });
  if (response.status!==201) throw new Error('Wallet não abriu'); return response.body as Opened;
}
async function awaitStatus(id: string,status: string) {
  return waitFor(() => api.request(`/wagering/transactions/${id}`),(response) => response.body['status']===status);
}
async function restartWorkers() { workers = await Promise.all(Array.from({ length: 3 },() => startWorker(db.config,workerEnv))); }

describe('E9: referências persistentes, TTL e retomada em processos reais', () => {
  beforeAll(async () => { db = await disposableDatabase(); api = await startApi(db.config,workerEnv); await restartWorkers(); });
  afterAll(async () => { await Promise.all(workers.map((w) => w.close())); await api?.close(); await db?.close(); });
  test('REFUND/ROLLBACK antes da BET são retomados uma vez por três workers concorrentes', async () => {
    const w = await open(); const reference = crypto.randomUUID();
    const refund = await submit(inputFor(w,'REFUND','10.00',reference));
    const rollback = await submit(inputFor(w,'ROLLBACK','10.00',reference));
    expect(refund.status).toBe(202); expect(rollback.status).toBe(202);
    const bet = inputFor(w,'BET'); bet.externalTransactionId=reference; expect((await submit(bet)).status).toBe(200);
    await awaitStatus(refund.body['transactionId'] as string,'PROCESSED');
    await awaitStatus(rollback.body['transactionId'] as string,'PROCESSED');
    expect((await api.request(`/wallets/${w.id}`)).body).toMatchObject({ balance: { amount: '110.00',currency: 'BRL' },version: 4 });
    for (const id of [refund.body['transactionId'],rollback.body['transactionId']]) {
      expect(await db.runtime.em.fork().execute('select count(*)::int as count from wallet_ledger_entries where transaction_id=?',[id])).toEqual([{ count: 1 }]);
      expect(await db.runtime.em.fork().execute("select count(*)::int as count from outbox_messages where aggregate_id=? and event_type='WagerTransactionPendingReference'",[id])).toEqual([{ count: 1 }]);
      expect(await db.runtime.em.fork().execute("select count(*)::int as count from outbox_messages where aggregate_id=? and event_type='WagerTransactionProcessed'",[id])).toEqual([{ count: 1 }]);
    }
    await assertReconciled(db.runtime.em.fork(),w.id);
  });
  test('reinício da API/workers retoma pendência e conserva primeiro 202, com terminal histórico real', async () => {
    await Promise.all(workers.map((w) => w.close())); workers=[];
    const w = await open(); const reference = crypto.randomUUID(); const input = inputFor(w,'WIN','5.00',reference);
    const original = await submit(input); expect(original.status).toBe(202);
    const bet = inputFor(w,'BET'); bet.externalTransactionId=reference; await submit(bet);
    await api.close(); api = await startApi(db.config,workerEnv); await restartWorkers();
    const current = await awaitStatus(original.body['transactionId'] as string,'PROCESSED');
    expect(current.body['terminalResult']).toMatchObject({ httpStatus: 200,body: { balance: { amount: '95.00',currency: 'BRL' } } });
    expect(await submit(input)).toEqual({ status: 202,body: { ...original.body,idempotentReplay: true } });
    await assertReconciled(db.runtime.em.fork(),w.id);
  });
  test('tempo/random controlados: retry confirmado, sem repetir PendingReference, e expiração NOT_FOUND', async () => {
    await Promise.all(workers.map((w) => w.close())); workers=[];
    const database = new PostgresFinancialDatabase(db.runtime);
    const w = await new WalletService(database).open({ playerId: crypto.randomUUID(),initialBalance: { amount: '100.00',currency: 'BRL' } });
    let now = new Date();
    const service = new WageringService(database,{ ttlMs: 100,baseDelayMs: 10,maxDelayMs: 100 },() => new Date(now),() => 0);
    const original = await service.process(inputFor(w,'REFUND','10.00','absent'),crypto.randomUUID());
    const id = original.body.transactionId;
    const initial = await database.transaction((session) => session.findTransactionById(id));
    expect(initial?.referenceAttempts).toBe(0); expect(initial?.nextReferenceAttemptAt).toEqual(new Date(now.getTime()+5));
    now = new Date(now.getTime()+6);
    expect((await service.retryReference(id,w.id))?.status).toBe(202);
    expect(await db.runtime.em.fork().execute('select reference_attempts from wager_transactions where id=?',[id])).toEqual([{ reference_attempts: 1 }]);
    now = new Date(now.getTime()+101);
    const expired = await service.retryReference(id,w.id); expect(expired?.body.failureCode).toBe(FailureCode.ReferenceNotFound);
    expect(await db.runtime.em.fork().execute("select count(*)::int as count from outbox_messages where aggregate_id=? and event_type='WagerTransactionPendingReference'",[id])).toEqual([{ count: 1 }]);
    expect((await service.get(id)).status).toBe(WagerTransactionStatus.Rejected); await assertReconciled(db.runtime.em.fork(),w.id);
  });
  test('referência ainda pendente expira NOT_READY; referência válida prevalece sobre TTL na retomada', async () => {
    const database = new PostgresFinancialDatabase(db.runtime); let now = new Date();
    const service = new WageringService(database,{ ttlMs: 100,baseDelayMs: 10,maxDelayMs: 100 },() => new Date(now),() => 0);
    const w = await open();
    const pending = await db.runtime.em.fork().transactional((em) => insertExternal(em,w.id,{ player_id: w.playerId }));
    const accepted = await service.process(inputFor(w,'REFUND','10.00',pending.external_transaction_id),crypto.randomUUID());
    now = new Date(now.getTime()+101);
    expect((await service.retryReference(accepted.body.transactionId,w.id))?.body.failureCode).toBe(FailureCode.ReferenceNotReady);
    const reference = crypto.randomUUID();
    const later = await service.process(inputFor(w,'REFUND','10.00',reference),crypto.randomUUID());
    const bet = inputFor(w,'BET'); bet.externalTransactionId=reference; await submit(bet);
    now = new Date(now.getTime()+101);
    expect((await service.retryReference(later.body.transactionId,w.id))?.status).toBe(200);
    await assertReconciled(db.runtime.em.fork(),w.id);
  });
  test('rollback do agendamento não consome tentativa nem perde vencimento persistido', async () => {
    const w = await open(); const database = new PostgresFinancialDatabase(db.runtime); let now = new Date();
    const policy = { ttlMs: 1000,baseDelayMs: 10,maxDelayMs: 100 };
    const service = new WageringService(database,policy,() => new Date(now),() => 0);
    const accepted = await service.process(inputFor(w,'REFUND','10.00','missing'),crypto.randomUUID());
    const id = accepted.body.transactionId;
    const before = await db.runtime.em.fork().execute('select reference_attempts,next_reference_attempt_at from wager_transactions where id=?',[id]);
    now = new Date(now.getTime()+6);
    const failing = new WageringService(new PostgresFinancialDatabase(db.runtime,{ afterWrite: async (step) => { if (step==='transaction') throw new Error('injected'); } }),policy,() => new Date(now),() => 0);
    await expect(failing.retryReference(id,w.id)).rejects.toThrow('injected');
    expect(await db.runtime.em.fork().execute('select reference_attempts,next_reference_attempt_at from wager_transactions where id=?',[id])).toEqual(before);
    expect((await service.retryReference(id,w.id))?.status).toBe(202);
    await assertReconciled(db.runtime.em.fork(),w.id);
  });
});
