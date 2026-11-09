import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { DeleteMessageCommand, ReceiveMessageCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
import { WalletService } from '../../src/application/wallet-service.js';
import { PostgresFinancialDatabase } from '../../src/infrastructure/database/postgres-financial-database.js';
import { payloadHash } from '../../src/application/wager-contract.js';
import { assertReconciled, disposableDatabase } from './database-fixture.js';
import { startApi } from './api-fixture.js';
import { isolatedQueues } from './sqs-fixture.js';
import { startWorker, waitFor } from './worker-fixture.js';

let db: Awaited<ReturnType<typeof disposableDatabase>>;
let queues: Awaited<ReturnType<typeof isolatedQueues>>;
let api: Awaited<ReturnType<typeof startApi>>;
let workers: Awaited<ReturnType<typeof startWorker>>[] = [];
const workerEnv={ WORKER_ROLES: 'publisher',WORKER_POLL_MS: '20',SQS_REQUEST_TIMEOUT_MS: '500',OUTBOX_RETRY_BASE_MS: '20',OUTBOX_RETRY_MAX_MS: '100' };
const deliveries: string[]=[];
async function stopWorkers() { await Promise.all(workers.map((w) => w.close())); workers=[]; }
async function open() {
  const r=await api.request('/wallets',{ playerId: crypto.randomUUID(),initialBalance: { amount: '100.00',currency: 'BRL' } });
  if (r.status!==201) throw new Error('Wallet não abriu'); return r.body['id'] as string;
}
async function allPublished() {
  await waitFor(async () => {
    const [row]=await db.runtime.em.fork().execute<{ count: number }[]>('select count(*)::int as count from outbox_messages where published_at is null');
    return row?.count===0;
  },(done) => done);
}
async function gate(worker: Awaited<ReturnType<typeof startWorker>>,point: string) {
  const messages=await waitFor(async () => worker.messages,(list) => list.some((item) => item && typeof item==='object' && 'point' in item && item.point===point));
  return messages.find((item) => item && typeof item==='object' && 'point' in item && item.point===point) as { eventId: string };
}
async function consumeBatch() {
  const result=await queues.client.send(new ReceiveMessageCommand({ QueueUrl: queues.events,MaxNumberOfMessages: 10,WaitTimeSeconds: 1,VisibilityTimeout: 30 }));
  for (const message of result.Messages ?? []) {
    const payload=JSON.parse(message.Body!) as Record<string,unknown>;
    const eventId=payload['eventId'] as string;
    deliveries.push(eventId);
    expect(payload['version']).toBe(1);
    expect(typeof ((payload['data'] as Record<string,unknown>)['money'] as Record<string,unknown>)['amount']).toBe('string');
    // A tabela de efeitos não tem unique em event_id: somente a inbox pode impedir dois efeitos.
    const sink=new PostgresFinancialDatabase(db.runtime,{ afterWrite: async (step,em) => {
      if (step==='inbox_processed') await em.execute('insert into test_event_effects values(?,?)',[crypto.randomUUID(),eventId]);
    } });
    await sink.transaction(async (session) => {
      const inbox=await session.claimInbox({ consumerName: 'test-event-sink',messageId: eventId,payloadHash: payloadHash(payload),receivedAt: new Date() });
      if (!inbox.isProcessed()) await session.completeInbox(inbox,new Date());
    });
    await queues.client.send(new DeleteMessageCommand({ QueueUrl: queues.events,ReceiptHandle: message.ReceiptHandle! }));
  }
}
async function drainUntil(check: () => Promise<boolean>) {
  const deadline=Date.now()+15000;
  do { await consumeBatch(); if (await check()) return; } while (Date.now()<deadline);
  throw new Error('Eventos não chegaram ao consumidor de teste');
}
async function drainAll() {
  await drainUntil(async () => {
    const [row]=await db.runtime.em.fork().execute<{ missing: number }[]>(`select count(*)::int as missing from outbox_messages o
      where not exists(select 1 from test_event_effects e where e.event_id=o.id)`);
    return row?.missing===0;
  });
  expect(await db.runtime.em.fork().execute('select event_id from test_event_effects group by event_id having count(*)<>1')).toEqual([]);
}
async function compose(...args: string[]) {
  const child=Bun.spawn(['docker','compose',...args],{ stdout: 'pipe',stderr: 'pipe' });
  const output=Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text()]);
  if (await child.exited!==0) throw new Error((await output).join('\n')); await output;
}

describe('E11: outbox, SKIP LOCKED e SQS reais', () => {
  beforeAll(async () => {
    db=await disposableDatabase(); queues=await isolatedQueues(db.config); api=await startApi(queues.config);
    await db.owner.em.fork().execute('create table test_event_effects(id text primary key,event_id text not null)');
    await db.owner.em.fork().execute('grant select,insert on test_event_effects to wagering_app');
  });
  afterAll(async () => { await stopWorkers(); await api?.close(); await queues?.close(); await db?.close(); });
  test('publisher não vê outbox não confirmada, mesmo após a escrita real do evento', async () => {
    let release!: () => void; let entered!: () => void; let held=false;
    const ready=new Promise<void>((resolve) => { entered=resolve; }); const barrier=new Promise<void>((resolve) => { release=resolve; });
    const service=new WalletService(new PostgresFinancialDatabase(db.runtime,{ afterWrite: async (step) => {
      if (step==='outbox' && !held) { held=true; entered(); await barrier; }
    } }));
    const opening=service.open({ playerId: crypto.randomUUID(),initialBalance: { amount: '100.00',currency: 'BRL' } });
    await ready;
    const publisher=await startWorker(queues.config,{ ...workerEnv,TEST_GATE: 'empty_outbox_selection' }); workers=[publisher];
    try {
      await gate(publisher,'empty_outbox_selection');
      expect((await queues.receive(queues.events)).Messages ?? []).toEqual([]);
    } finally { release(); publisher.child.send({ release: 'empty_outbox_selection' }); }
    const wallet=await opening; await allPublished(); await drainAll(); await assertReconciled(db.runtime.em.fork(),wallet.id); await stopWorkers();
  });
  test('dois publishers dividem linhas; o segundo pula o lock do primeiro e conclui as demais', async () => {
    const wallets=await Promise.all(Array.from({ length: 5 },() => open()));
    const pending=await db.runtime.em.fork().execute<{ id: string }[]>('select id from outbox_messages where published_at is null');
    expect(pending).toHaveLength(10);
    const first=await startWorker(queues.config,{ ...workerEnv,TEST_GATE: 'before_send' }); workers=[first];
    const locked=await gate(first,'before_send');
    const second=await startWorker(queues.config,workerEnv); workers.push(second);
    expect(first.child.pid).not.toBe(second.child.pid);
    await waitFor(async () => {
      const [row]=await db.runtime.em.fork().execute<{ count: number }[]>('select count(*)::int as count from outbox_messages where published_at is null');
      return row?.count===1;
    },(done) => done);
    expect(await db.runtime.em.fork().execute('select published_at from outbox_messages where id=?',[locked.eventId])).toEqual([{ published_at: null }]);
    first.child.send({ release: 'before_send' }); await allPublished(); await drainAll();
    expect(first.output()).toContain('outbox_sent'); expect(second.output()).toContain('outbox_sent');
    for (const id of wallets) await assertReconciled(db.runtime.em.fork(),id);
    await stopWorkers();
  });
  test.each(['before_send','after_send'])('crash na barreira %s não perde evento e mantém eventId em republicação', async (point) => {
    const walletId=await open();
    const doomed=await startWorker(queues.config,{ ...workerEnv,TEST_GATE: point }); workers=[doomed];
    const locked=await gate(doomed,point);
    if (point==='after_send') await drainUntil(async () => deliveries.includes(locked.eventId));
    expect(await db.runtime.em.fork().execute('select published_at from outbox_messages where id=?',[locked.eventId])).toEqual([{ published_at: null }]);
    doomed.child.kill('SIGKILL'); await doomed.child.exited; await doomed.logs; workers=[];
    workers=await Promise.all(Array.from({ length: 2 },() => startWorker(queues.config,workerEnv)));
    await allPublished();
    if (point==='after_send') {
      const [row]=await db.runtime.em.fork().execute<{ payload: Record<string,unknown> }[]>('select payload from outbox_messages where id=?',[locked.eventId]);
      // Broker real, dedup de transporte deliberadamente diferente: representa repetição além da janela FIFO sem esperar 5min.
      await queues.client.send(new SendMessageCommand({ QueueUrl: queues.events,MessageBody: JSON.stringify(row!.payload),MessageGroupId: walletId,MessageDeduplicationId: crypto.randomUUID() }));
      await drainUntil(async () => deliveries.filter((id) => id===locked.eventId).length>=2);
      expect(await db.runtime.em.fork().execute('select count(*)::int as count from test_event_effects where event_id=?',[locked.eventId])).toEqual([{ count: 1 }]);
    }
    await drainAll(); await assertReconciled(db.runtime.em.fork(),walletId); await stopWorkers();
  });
  test('indisponibilidade SQS persiste backoff e retoma backlog com eventId/envelope originais', async () => {
    const walletId=await open(); const before=await db.runtime.em.fork().execute('select id,payload from outbox_messages where published_at is null order by id');
    const paused=await startWorker(queues.config,{ ...workerEnv,TEST_GATE: 'before_send' }); workers=[paused];
    const locked=await gate(paused,'before_send');
    await compose('pause','localstack');
    try {
      paused.child.send({ release: 'before_send' });
      await waitFor(async () => {
        const [row]=await db.runtime.em.fork().execute<{ attempts: number }[]>('select attempts from outbox_messages where id=?',[locked.eventId]);
        return (row?.attempts ?? 0)>=1;
      },(done) => done);
      expect(await db.runtime.em.fork().execute('select id,payload from outbox_messages where published_at is null order by id')).toEqual(before);
      await stopWorkers();
    } finally { await compose('unpause','localstack'); }
    workers=await Promise.all(Array.from({ length: 2 },() => startWorker(queues.config,workerEnv)));
    await allPublished(); await drainAll(); await assertReconciled(db.runtime.em.fork(),walletId); await stopWorkers();
  });
});
