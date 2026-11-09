import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { WalletService } from '../../src/application/wallet-service.js';
import { PostgresFinancialDatabase } from '../../src/infrastructure/database/postgres-financial-database.js';
import { assertReconciled, disposableDatabase } from './database-fixture.js';
import { startApi } from './api-fixture.js';
import { isolatedQueues } from './sqs-fixture.js';
import { startWorker } from './worker-fixture.js';
import { waitFor } from './worker-fixture.js';
import { GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { WageringService } from '../../src/application/wagering-service.js';
import { Telemetry } from '../../src/infrastructure/observability/telemetry.js';

let db: Awaited<ReturnType<typeof disposableDatabase>>;
let queues: Awaited<ReturnType<typeof isolatedQueues>>;
let api: Awaited<ReturnType<typeof startApi>>;
type Opened={ id: string; playerId: string };
async function open(amount = '100.00'): Promise<Opened> {
  const r=await api.request('/wallets',{ playerId: crypto.randomUUID(),initialBalance: { amount,currency: 'BRL' } });
  if (r.status!==201) throw new Error('Wallet não abriu'); return r.body as Opened;
}
function bet(w: Opened) { return { providerId: 'provider',externalTransactionId: crypto.randomUUID(),walletId: w.id,playerId: w.playerId,
  roundId: 'round',gameId: 'game',kind: 'BET',money: { amount: '10.00',currency: 'BRL' } }; }

describe('E12: reconciliação consistente e observabilidade real', () => {
  beforeAll(async () => { db=await disposableDatabase(); queues=await isolatedQueues(db.config); api=await startApi(queues.config); });
  afterAll(async () => { await api?.close(); await queues?.close(); await db?.close(); });
  test('reconciliação positiva/zero soma opening, conta entradas e devolve MoneyProps exatos', async () => {
    const zero=await open('0.00');
    expect((await api.request(`/wallets/${zero.id}/reconciliation`,{})).body).toEqual({ walletId: zero.id,storedBalance: { amount: '0.00',currency: 'BRL' },
      calculatedBalance: { amount: '0.00',currency: 'BRL' },difference: { amount: '0.00',currency: 'BRL' },consistent: true,checkedEntries: 0 });
    const w=await open(); const input=bet(w); await api.request('/wagering/transactions',input,{ 'idempotency-key': input.externalTransactionId });
    expect((await api.request(`/wallets/${w.id}/reconciliation`,{})).body).toMatchObject({ storedBalance: { amount: '90.00',currency: 'BRL' },
      calculatedBalance: { amount: '90.00',currency: 'BRL' },consistent: true,checkedEntries: 2 });
    await assertReconciled(db.runtime.em.fork(),w.id);
  });
  test('REPEATABLE READ mantém mesmo snapshot quando BET confirma entre leitura de wallet e soma', async () => {
    const w=await open(); let release!: () => void; let entered!: () => void;
    const ready=new Promise<void>((resolve) => { entered=resolve; }); const barrier=new Promise<void>((resolve) => { release=resolve; });
    const service=new WalletService(new PostgresFinancialDatabase(db.runtime,{ afterReconciliationWalletRead: async () => { entered(); await barrier; } }));
    const old=service.reconcile(w.id); await ready;
    try { const input=bet(w); expect((await api.request('/wagering/transactions',input,{ 'idempotency-key': input.externalTransactionId })).status).toBe(200); }
    finally { release(); }
    expect(await old).toMatchObject({ storedBalance: { amount: '100.00',currency: 'BRL' },calculatedBalance: { amount: '100.00',currency: 'BRL' },consistent: true,checkedEntries: 1 });
    expect((await api.request(`/wallets/${w.id}/reconciliation`,{})).body).toMatchObject({ calculatedBalance: { amount: '90.00',currency: 'BRL' },consistent: true,checkedEntries: 2 });
    await assertReconciled(db.runtime.em.fork(),w.id);
  });
  test('divergência administrativa controlada é sinalizada/logada/contada sem reparo silencioso', async () => {
    const w=await open();
    await db.owner.em.fork().execute('alter table wallets disable trigger user');
    try { await db.owner.em.fork().execute('update wallets set balance_minor=10001 where id=?',[w.id]); }
    finally { await db.owner.em.fork().execute('alter table wallets enable trigger user'); }
    try {
      const r=await api.request(`/wallets/${w.id}/reconciliation`,{});
      expect(r.status).toBe(200); expect(r.body).toMatchObject({ consistent: false,difference: { amount: '0.01',currency: 'BRL' } });
      expect((await api.request(`/wallets/${w.id}`)).body['balance']).toEqual({ amount: '100.01',currency: 'BRL' });
      const text=await (await fetch(`${api.url}/metrics`)).text(); expect(text).toContain('wager_reconciliation_divergences_total 1');
      expect(api.output()).toContain('reconciliation_divergence');
    } finally {
      // Apenas limpeza da corrupção criada pelo teste; a aplicação não corrige nada.
      await db.owner.em.fork().execute('alter table wallets disable trigger user');
      try { await db.owner.em.fork().execute('update wallets set balance_minor=10000 where id=?',[w.id]); }
      finally { await db.owner.em.fork().execute('alter table wallets enable trigger user'); }
    }
    await assertReconciled(db.runtime.em.fork(),w.id);
  });
  test('métricas de estado/duplicatas/retries/DLQ/locks/outbox/latência sem IDs como labels', async () => {
    const w=await open(); const input=bet(w);
    await api.request('/wagering/transactions',input,{ 'idempotency-key': input.externalTransactionId,'x-correlation-id': 'interview-trace' });
    await api.request('/wagering/transactions',input,{ 'idempotency-key': input.externalTransactionId });
    const response=await fetch(`${api.url}/metrics`); const text=await response.text();
    expect(response.status).toBe(200); expect(response.headers.get('content-type')).toContain('text/plain');
    for (const name of ['wager_transactions{status="PROCESSED"}','wager_duplicates_total 1','wager_db_retries_total','wager_command_retries_total',
      'wager_outbox_retries_total','wager_dlq_messages','wager_wallet_lock_waits','wager_outbox_pending','wager_outbox_lag_seconds','wager_processing_duration_seconds_bucket']) expect(text).toContain(name);
    expect(text).not.toContain(w.id); expect(text).not.toContain(w.playerId);
    const entries=api.output().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string,unknown>);
    expect(entries.some((entry) => entry['event']==='transaction_result' && entry['correlationId']==='interview-trace' && entry['walletId']===w.id && typeof entry['transactionId']==='string')).toBe(true);
    for (const entry of entries) for (const key of ['money','balance','payload','authorization','idempotencyKey','storedBalance']) expect(Object.hasOwn(entry,key)).toBe(false);
    await assertReconciled(db.runtime.em.fork(),w.id);
  });
  test('espera real por lock aparece na métrica sem associar IDs a labels', async () => {
    const w=await open(); let release!: () => void; let entered!: () => void;
    const ready=new Promise<void>((resolve) => { entered=resolve; }); const barrier=new Promise<void>((resolve) => { release=resolve; });
    const hold=db.runtime.em.fork().transactional(async (em) => { await em.execute('select id from wallets where id=? for update',[w.id]); entered(); await barrier; });
    await ready; const input=bet(w); const request=api.request('/wagering/transactions',input,{ 'idempotency-key': input.externalTransactionId });
    try {
      await waitFor(async () => {
        const text=await (await fetch(`${api.url}/metrics`)).text();
        return Number(text.match(/^wager_wallet_lock_waits ([0-9]+)/m)?.[1] ?? '0');
      },(count) => count>=1);
    } finally { release(); await hold; }
    expect((await request).status).toBe(200); await assertReconciled(db.runtime.em.fork(),w.id);
  });
  test('worker expõe métricas próprias; retries e DLQ refletem recebimentos reais', async () => {
    const worker=await startWorker(queues.config,{ WORKER_ROLES: 'commands',WORKER_POLL_MS: '20',COMMAND_WAIT_SECONDS: '1',
      COMMAND_VISIBILITY_SECONDS: '1',COMMAND_RETRY_BASE_MS: '10',COMMAND_RETRY_MAX_MS: '100' });
    try {
      const entry=worker.output().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string,unknown>).find((row) => row['event']==='workers_started');
      await queues.send('{invalid-json');
      await waitFor(async () => {
        const attributes=await queues.client.send(new GetQueueAttributesCommand({ QueueUrl: queues.dlq,AttributeNames: ['ApproximateNumberOfMessages'] }));
        return Number(attributes.Attributes?.['ApproximateNumberOfMessages'] ?? '0');
      },(count) => count>=1,20000);
      const r=await fetch(`http://127.0.0.1:${entry!['metricsPort']}/metrics`);
      expect(r.status).toBe(200); const text=await r.text(); expect(text).toContain('wager_dlq_messages 1');
      expect(Number(text.match(/^wager_command_retries_total ([0-9]+)/m)?.[1] ?? '0')).toBeGreaterThanOrEqual(4);
    } finally { await worker.close(); }
  });
  test('SQLSTATE transitório real após escrita repete com EM novo e incrementa métrica uma vez', async () => {
    const w=await open(); const input=bet(w); const telemetry=new Telemetry(); let failures=0;
    const contexts=new Set<object>();
    const database=new PostgresFinancialDatabase(db.runtime,{ afterWrite: async (step,em) => {
      if (step==='ledger') {
        contexts.add(em);
        if (failures++===0) await em.execute("do $$ begin raise exception 'test serialization retry' using errcode='40001'; end $$");
      }
    } },telemetry);
    expect((await new WageringService(database).process(input,input.externalTransactionId)).status).toBe(200);
    expect(contexts.size).toBe(2); expect(telemetry.render()).toContain('wager_db_retries_total 1');
    expect((await api.request(`/wallets/${w.id}`)).body).toMatchObject({ balance: { amount: '90.00',currency: 'BRL' },version: 2 });
    await assertReconciled(db.runtime.em.fork(),w.id);
  });
  test('retries SQL têm limite de três tentativas e esgotamento não confirma nada', async () => {
    const w=await open(); const input=bet(w); const telemetry=new Telemetry(); const contexts=new Set<object>();
    const database=new PostgresFinancialDatabase(db.runtime,{ afterWrite: async (step,em) => {
      if (step==='ledger') { contexts.add(em); await em.execute("do $$ begin raise exception 'test retries exhausted' using errcode='40001'; end $$"); }
    } },telemetry);
    await expect(new WageringService(database).process(input,input.externalTransactionId)).rejects.toMatchObject({ code: '40001' });
    expect(contexts.size).toBe(3); expect(telemetry.render()).toContain('wager_db_retries_total 2');
    expect((await api.request(`/wallets/${w.id}`)).body['version']).toBe(1);
    expect(await db.runtime.em.fork().execute('select id from wager_transactions where external_transaction_id=?',[input.externalTransactionId])).toEqual([]);
    await assertReconciled(db.runtime.em.fork(),w.id);
  });
});
