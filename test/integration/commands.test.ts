import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { WageringService } from '../../src/application/wagering-service.js';
import { PostgresFinancialDatabase } from '../../src/infrastructure/database/postgres-financial-database.js';
import { payloadHash } from '../../src/application/wager-contract.js';
import { CommandConsumer, commandEnvelopeContract } from '../../src/infrastructure/workers/command-consumer.js';
import { assertReconciled, disposableDatabase } from './database-fixture.js';
import { startApi } from './api-fixture.js';
import { isolatedQueues } from './sqs-fixture.js';
import { startWorker, waitFor } from './worker-fixture.js';

let db: Awaited<ReturnType<typeof disposableDatabase>>;
let queues: Awaited<ReturnType<typeof isolatedQueues>>;
let api: Awaited<ReturnType<typeof startApi>>;
let workers: Awaited<ReturnType<typeof startWorker>>[] = [];
const workerEnv = { WORKER_ROLES: 'commands',WORKER_POLL_MS: '20',COMMAND_WAIT_SECONDS: '1',COMMAND_VISIBILITY_SECONDS: '1',
  COMMAND_RETRY_BASE_MS: '10',COMMAND_RETRY_MAX_MS: '100',DB_TIMEOUT_MS: '1000',SQS_REQUEST_TIMEOUT_MS: '500',
  REFERENCE_BASE_DELAY_MS: '20',REFERENCE_MAX_DELAY_MS: '100' };
type Opened = { id: string; playerId: string };
async function open(): Promise<Opened> {
  const r = await api.request('/wallets',{ playerId: crypto.randomUUID(),initialBalance: { amount: '100.00',currency: 'BRL' } });
  if (r.status!==201) throw new Error('Wallet não abriu'); return r.body as Opened;
}
function envelope(w: Opened) {
  const key = crypto.randomUUID();
  return { messageId: crypto.randomUUID(),type: 'WagerTransactionRequested',occurredAt: new Date().toISOString(),data: {
    providerId: 'provider',externalTransactionId: key,idempotencyKey: key,playerId: w.playerId,walletId: w.id,
    roundId: 'round',gameId: 'game',kind: 'BET',money: { amount: '10.00',currency: 'BRL' },
  } };
}
const rowsFor = (id: string) => db.runtime.em.fork().execute<{ processed: boolean }[]>("select processed_at is not null as processed from inbox_messages where consumer_name='wager-transactions-v1' and message_id=?",[id]);
async function acked(id: string) { await waitFor(() => rowsFor(id),(rows) => rows[0]?.processed===true); }
function logs() { return workers.flatMap((w) => w.output().split('\n').flatMap((line) => { try { return [JSON.parse(line) as Record<string,unknown>]; } catch { return []; } })); }
async function stopWorkers() { await Promise.all(workers.map((w) => w.close())); workers=[]; }
async function startNormal() { workers=await Promise.all(Array.from({ length: 3 },() => startWorker(queues.config,workerEnv))); }
async function counts() {
  return db.runtime.em.fork().execute(`select (select count(*)::int from wager_transactions) as transactions,
    (select count(*)::int from wallet_ledger_entries) as ledger,(select count(*)::int from inbox_messages) as inbox,(select count(*)::int from outbox_messages) as outbox`);
}
async function compose(...args: string[]) {
  const child=Bun.spawn(['docker','compose',...args],{ stdout: 'pipe',stderr: 'pipe' });
  const output=Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text()]);
  if (await child.exited!==0) throw new Error(`Compose falhou: ${(await output).join('\n')}`);
  await output;
}

describe('E10: SQS real, inbox, redrive e processos', () => {
  beforeAll(async () => { db=await disposableDatabase(); queues=await isolatedQueues(db.config); api=await startApi(queues.config); await startNormal(); });
  afterAll(async () => { await stopWorkers(); await api?.close(); await queues?.close(); await db?.close(); });
  test('redrive real configurado para cinco recebimentos e DLQ FIFO', async () => {
    const attributes = await queues.client.send(new GetQueueAttributesCommand({ QueueUrl: queues.commands,AttributeNames: ['RedrivePolicy','FifoQueue'] }));
    expect(attributes.Attributes?.['FifoQueue']).toBe('true');
    expect(JSON.parse(attributes.Attributes?.['RedrivePolicy'] ?? '{}').maxReceiveCount).toBe(5);
  });
  test('mesma operação por HTTP + 25 envelopes SQS em três consumidores causa um efeito', async () => {
    const w=await open(); const original=envelope(w); const { idempotencyKey,...command }=original.data;
    const messages=Array.from({ length: 25 },() => ({ ...original,messageId: crypto.randomUUID() }));
    const http=Array.from({ length: 25 },() => api.request('/wagering/transactions',command,{ 'idempotency-key': idempotencyKey }));
    await Promise.all([...http,...messages.map((message) => queues.send(message))]);
    await Promise.all(messages.map((message) => acked(message.messageId)));
    expect(await db.runtime.em.fork().execute("select count(*)::int as count from wallet_ledger_entries where wallet_id=? and direction='DEBIT'",[w.id])).toEqual([{ count: 1 }]);
    expect(await db.runtime.em.fork().execute('select count(*)::int as count from wager_transactions where external_transaction_id=?',[original.data.externalTransactionId])).toEqual([{ count: 1 }]);
    expect((await api.request(`/wallets/${w.id}`)).body['balance']).toEqual({ amount: '90.00',currency: 'BRL' });
    await assertReconciled(db.runtime.em.fork(),w.id);
  });
  test('mesmo messageId reenviado sem dedup do broker tem uma inbox e um débito', async () => {
    const w=await open(); const message=envelope(w);
    await Promise.all([queues.send(message),queues.send(message)]);
    await acked(message.messageId);
    await waitFor(async () => logs().filter((entry) => entry['event']==='command_acked' && entry['messageId']===message.messageId).length,(count) => count>=2);
    expect(await rowsFor(message.messageId)).toEqual([{ processed: true }]);
    expect((await api.request(`/wallets/${w.id}`)).body['version']).toBe(2);
    await assertReconciled(db.runtime.em.fork(),w.id);
  });
  test('rejeição de negócio confirma inbox e dá ack sem gerar ledger ou retry', async () => {
    const w=await open(); const message=envelope(w); message.data.money.amount='101.00';
    await queues.send(message); await acked(message.messageId);
    const transaction=await api.request(`/providers/provider/wagering/transactions/${message.data.externalTransactionId}`);
    expect(transaction.body['status']).toBe('REJECTED'); expect(transaction.body['failureCode']).toBe('INSUFFICIENT_FUNDS');
    expect(await db.runtime.em.fork().execute('select id from wallet_ledger_entries where transaction_id=?',[transaction.body['transactionId']])).toEqual([]);
    await assertReconciled(db.runtime.em.fork(),w.id);
  });
  test('REFUND/ROLLBACK SQS antes da referência confirmam inbox e são retomados sem nova mensagem', async () => {
    const reference=crypto.randomUUID(); const w=await open();
    const pending=['REFUND','ROLLBACK'].map((kind) => { const original=envelope(w); return { ...original,data: { ...original.data,kind,referenceExternalTransactionId: reference } }; });
    await Promise.all(pending.map((message) => queues.send(message))); await Promise.all(pending.map((message) => acked(message.messageId)));
    expect((await api.request(`/wallets/${w.id}`)).body['version']).toBe(1);
    const reprocessor=await startWorker(queues.config,{ ...workerEnv,WORKER_ROLES: 'references' }); workers.push(reprocessor);
    const bet=envelope(w); bet.data.externalTransactionId=reference; bet.data.idempotencyKey=reference;
    await queues.send(bet); await acked(bet.messageId);
    for (const message of pending) await waitFor(() => api.request(`/providers/provider/wagering/transactions/${message.data.externalTransactionId}`),(r) => r.body['status']==='PROCESSED');
    expect((await api.request(`/wallets/${w.id}`)).body).toMatchObject({ balance: { amount: '110.00',currency: 'BRL' },version: 4 });
    await assertReconciled(db.runtime.em.fork(),w.id);
  });
  test('messageId com hash divergente vai à DLQ sem alterar efeito original', async () => {
    const w=await open(); const message=envelope(w); await queues.send(message); await acked(message.messageId);
    const changed={ ...message,data: { ...message.data,money: { amount: '20.00',currency: 'BRL' } } };
    await queues.send(changed);
    const dlq=await waitFor(() => queues.receive(queues.dlq),(result) => (result.Messages?.length ?? 0)>0,20000);
    expect(JSON.parse(dlq.Messages![0]!.Body!).messageId).toBe(message.messageId);
    expect(logs().some((entry) => entry['code']==='INBOX_PAYLOAD_CONFLICT' && Number(entry['receiveCount'])>=5)).toBe(true);
    expect((await api.request(`/wallets/${w.id}`)).body['balance']).toEqual({ amount: '90.00',currency: 'BRL' });
    await assertReconciled(db.runtime.em.fork(),w.id);
  });
  test('JSON inválido é redirigido à DLQ após retries limitados, sem entidade financeira artificial', async () => {
    const before=await counts(); const sent=await queues.send('{invalid-json');
    await waitFor(() => queues.receive(queues.dlq),(result) => result.Messages?.some((message) => message.Body==='{invalid-json')===true,20000);
    expect(logs().some((entry) => entry['messageId']===sent.MessageId && Number(entry['receiveCount'])>=5)).toBe(true);
    expect(await counts()).toEqual(before);
  });
  test.each(['before_commit','after_commit'])('matar consumidor na barreira %s permite redelivery com efeito único', async (point) => {
    await stopWorkers(); const w=await open(); const message=envelope(w);
    const doomed=await startWorker(queues.config,{ ...workerEnv,WORKER_BATCH_SIZE: '1',TEST_GATE: point }); workers=[doomed];
    await queues.send(message);
    await waitFor(async () => doomed.messages,(messages) => messages.some((item) => item && typeof item==='object' && 'point' in item && item.point===point));
    const committed=point==='after_commit';
    expect((await rowsFor(message.messageId)).length).toBe(committed ? 1 : 0);
    expect((await api.request(`/wallets/${w.id}`)).body['version']).toBe(committed ? 2 : 1);
    doomed.child.kill('SIGKILL'); await doomed.child.exited; await doomed.logs; workers=[];
    await startNormal(); await acked(message.messageId);
    await waitFor(async () => logs().some((entry) => entry['event']==='command_acked' && entry['messageId']===message.messageId && Number(entry['receiveCount'])>=2),(found) => found);
    expect((await api.request(`/wallets/${w.id}`)).body['version']).toBe(2);
    expect(await db.runtime.em.fork().execute('select count(*)::int as count from wallet_ledger_entries where wallet_id=?',[w.id])).toEqual([{ count: 2 }]);
    await assertReconciled(db.runtime.em.fork(),w.id);
  });
  test.each(['inbox','transaction','wallet','ledger','outbox','inbox_processed','commit'])('falha em %s faz rollback inclusive da inbox e não dá ack', async (step) => {
    await stopWorkers(); const w=await open(); const message=envelope(w); const before=await counts();
    const own=await isolatedQueues(db.config);
    try {
      await own.send(message);
      const received=await waitFor(() => own.receive(),(result) => (result.Messages?.length ?? 0)>0);
      expect(received.Messages).toHaveLength(1); expect(JSON.parse(received.Messages![0]!.Body!).messageId).toBe(message.messageId);
      const database=new PostgresFinancialDatabase(db.runtime,{ afterWrite: async (written,em) => {
        if (written===step) throw new Error('injected');
        if (step==='commit' && written==='inbox_processed') await em.execute('update wallets set balance_minor=balance_minor+1,version=version+1 where id=?',[w.id]);
      } });
      const consumer=new CommandConsumer(own.client,new WageringService(database),{ ...own.config,COMMAND_VISIBILITY_SECONDS: 1,COMMAND_RETRY_BASE_MS: 10,COMMAND_RETRY_MAX_MS: 100 });
      await consumer.handle(received.Messages![0]!,own.commands,new AbortController().signal);
      expect(await counts()).toEqual(before);
      const redelivery=await waitFor(() => own.receive(),(result) => (result.Messages?.length ?? 0)>0);
      expect(JSON.parse(redelivery.Messages![0]!.Body!).messageId).toBe(message.messageId);
      expect(Number(redelivery.Messages![0]!.Attributes?.['ApproximateReceiveCount'])).toBeGreaterThanOrEqual(2);
      const healthy=new CommandConsumer(own.client,new WageringService(new PostgresFinancialDatabase(db.runtime)),own.config);
      await healthy.handle(redelivery.Messages![0]!,own.commands,new AbortController().signal);
      await acked(message.messageId); await assertReconciled(db.runtime.em.fork(),w.id);
    } finally { await own.close(); }
  });
  test('PostgreSQL parado e recuperado provoca retry real, sem ack prematuro ou efeito duplicado', async () => {
    await stopWorkers();
    workers=await Promise.all(Array.from({ length: 3 },() => startWorker(queues.config,{ ...workerEnv,COMMAND_RETRY_BASE_MS: '2000',COMMAND_RETRY_MAX_MS: '4000' })));
    const w=await open(); const message=envelope(w);
    await compose('stop','postgres');
    try {
      await queues.send(message);
      await waitFor(async () => logs().some((entry) => entry['event']==='command_retry' && entry['messageId']===message.messageId),(found) => found);
      expect((await api.request('/health/live')).status).toBe(200);
      expect((await api.request('/health/ready')).status).toBe(503);
    } finally { await compose('up','-d','--wait','--wait-timeout','60','postgres'); }
    await acked(message.messageId);
    await waitFor(async () => logs().some((entry) => entry['event']==='command_acked' && entry['messageId']===message.messageId && Number(entry['receiveCount'])>=2),(found) => found);
    expect((await api.request(`/wallets/${w.id}`)).body['version']).toBe(2);
    await assertReconciled(db.runtime.em.fork(),w.id);
  });
  test('falha real no ack após commit não altera a transação; duplicata continua segura após retorno do SQS', async () => {
    await stopWorkers(); const w=await open(); const message=envelope(w);
    const gated=await startWorker(queues.config,{ ...workerEnv,WORKER_BATCH_SIZE: '1',TEST_GATE: 'after_commit' }); workers=[gated];
    await queues.send(message);
    await waitFor(async () => gated.messages,(messages) => messages.some((item) => item && typeof item==='object' && 'point' in item && item.point==='after_commit'));
    await compose('pause','localstack');
    try {
      gated.child.send({ release: 'after_commit' });
      await waitFor(async () => logs().some((entry) => entry['event']==='command_retry' && entry['messageId']===message.messageId && entry['committed']===true),(found) => found);
      expect((await api.request('/health/live')).status).toBe(200); expect((await api.request('/health/ready')).status).toBe(503);
      expect((await api.request(`/wallets/${w.id}`)).body['version']).toBe(2);
    } finally { await compose('unpause','localstack'); }
    // DeleteMessage pode ter chegado apesar do timeout: reenviar o mesmo envelope exercita ambos os desfechos possíveis.
    await queues.send(message);
    await waitFor(async () => logs().some((entry) => entry['event']==='command_acked' && entry['messageId']===message.messageId && entry['replay']===true),(found) => found);
    expect((await api.request(`/wallets/${w.id}`)).body['version']).toBe(2);
    await assertReconciled(db.runtime.em.fork(),w.id);
  });
  test('SIGTERM devolve visibilidade de trabalho em andamento e drena com consistência', async () => {
    await stopWorkers(); const w=await open(); const message=envelope(w);
    let release!: () => void; let entered!: () => void;
    const ready=new Promise<void>((resolve) => { entered=resolve; }); const gate=new Promise<void>((resolve) => { release=resolve; });
    const holder=db.runtime.em.fork().transactional(async (em) => { await em.execute('select id from wallets where id=? for update',[w.id]); entered(); await gate; });
    await ready;
    const worker=await startWorker(queues.config,{ ...workerEnv,DB_TIMEOUT_MS: '10000',WORKER_BATCH_SIZE: '1' }); workers=[worker];
    let redelivery;
    try {
      await queues.send(message);
      await waitFor(async () => {
        const [row]=await db.runtime.em.fork().execute<{ blocked: boolean }[]>('select exists(select 1 from pg_stat_activity where application_name=? and cardinality(pg_blocking_pids(pid))>0) as blocked',[`backend-challenge:${worker.child.pid}`]);
        return row?.blocked===true;
      },(blocked) => blocked);
      worker.child.kill('SIGTERM');
      redelivery=await waitFor(() => queues.receive(),(result) => result.Messages?.some((item) => JSON.parse(item.Body!).messageId===message.messageId)===true);
    } finally { release(); await holder; }
    await Promise.race([worker.child.exited,Bun.sleep(5000)]); expect(worker.child.exitCode).toBe(0); workers=[];
    const received=redelivery.Messages!.find((item) => JSON.parse(item.Body!).messageId===message.messageId)!;
    const healthy=new CommandConsumer(queues.client,new WageringService(new PostgresFinancialDatabase(db.runtime)),queues.config);
    await healthy.handle(received,queues.commands,new AbortController().signal);
    await acked(message.messageId); expect((await api.request(`/wallets/${w.id}`)).body['version']).toBe(2);
    await assertReconciled(db.runtime.em.fork(),w.id);
  });
  test('SIGTERM conclui consumidor ocioso sem SIGKILL; inbox canônica inclui envelope lógico', async () => {
    await startNormal(); const worker=workers.pop()!; await worker.close(); expect(worker.child.exitCode).toBe(0);
    const w=await open(); const message=envelope(w);
    const parsed=commandEnvelopeContract.parse(message);
    const hash=payloadHash(parsed); expect(hash).toHaveLength(64);
    expect(payloadHash({ ...parsed,occurredAt: new Date(Date.now()+1).toISOString() })).not.toBe(hash);
    await queues.send(message); await acked(message.messageId);
    await assertReconciled(db.runtime.em.fork(),w.id);
  });
});
