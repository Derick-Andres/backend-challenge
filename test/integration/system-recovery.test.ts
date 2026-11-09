import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { DeleteMessageCommand, GetQueueAttributesCommand, ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import { assertReconciled, disposableDatabase } from './database-fixture.js';
import { startApi } from './api-fixture.js';
import { isolatedQueues } from './sqs-fixture.js';
import { startWorker, waitFor } from './worker-fixture.js';

let db: Awaited<ReturnType<typeof disposableDatabase>>;
let queues: Awaited<ReturnType<typeof isolatedQueues>>;
let apis: Awaited<ReturnType<typeof startApi>>[]=[];
let workers: Awaited<ReturnType<typeof startWorker>>[]=[];
const runtimeEnv={ WORKER_ROLES: 'references,commands,publisher',WORKER_POLL_MS: '20',COMMAND_WAIT_SECONDS: '1',
  COMMAND_VISIBILITY_SECONDS: '2',REFERENCE_BASE_DELAY_MS: '20',REFERENCE_MAX_DELAY_MS: '100',OUTBOX_RETRY_BASE_MS: '20',OUTBOX_RETRY_MAX_MS: '100' };
type Opened={ id: string; playerId: string };
function command(w: Opened,kind: string,amount: string,reference?: string) {
  const key=crypto.randomUUID();
  return { providerId: 'provider',externalTransactionId: key,playerId: w.playerId,walletId: w.id,roundId: 'round',gameId: 'game',kind,money: { amount,currency: 'BRL' },
    ...(reference===undefined ? {} : { referenceExternalTransactionId: reference }) };
}
function envelope(input: ReturnType<typeof command>) { return { messageId: crypto.randomUUID(),type: 'WagerTransactionRequested',occurredAt: new Date().toISOString(),
  data: { ...input,idempotencyKey: input.externalTransactionId } }; }
async function startAll() {
  apis=await Promise.all(Array.from({ length: 3 },() => startApi(queues.config,runtimeEnv)));
  workers=await Promise.all(Array.from({ length: 3 },() => startWorker(queues.config,runtimeEnv)));
}
async function allInboxes(ids: string[]) {
  await waitFor(async () => {
    const [row]=await db.runtime.em.fork().execute<{ count: number }[]>(`select count(*)::int as count from inbox_messages
      where consumer_name=? and message_id in (${ids.map(() => '?').join(',')}) and processed_at is not null`,['wager-transactions-v1',...ids]);
    return row?.count===ids.length;
  },(done) => done,20000);
}

describe('E13: reinício global, backlog e consistência final', () => {
  beforeAll(async () => { db=await disposableDatabase(); queues=await isolatedQueues(db.config); await startAll(); });
  afterAll(async () => { await Promise.all(workers.map((worker) => worker.close())); await Promise.all(apis.map((api) => api.close())); await queues?.close(); await db?.close(); });
  test('três APIs e três workers recuperam pendências/filas/outbox após crash das APIs e reinício do PostgreSQL', async () => {
    const firstPids=[...apis.map((api) => api.child.pid),...workers.map((worker) => worker.child.pid)];
    expect(new Set(firstPids).size).toBe(6);
    const opened=await apis[0]!.request('/wallets',{ playerId: crypto.randomUUID(),initialBalance: { amount: '100.00',currency: 'BRL' } });
    expect(opened.status).toBe(201); const w=opened.body as Opened;
    const bet=command(w,'BET','10.00');
    const reference=crypto.randomUUID();
    const pending=[envelope(command(w,'REFUND','5.00',reference)),envelope(command(w,'ROLLBACK','5.00',reference))];
    await Promise.all(pending.map((input) => queues.send(input,w.id))); await allInboxes(pending.map((input) => input.messageId));
    for (const input of pending) expect((await apis[1]!.request(`/providers/provider/wagering/transactions/${input.data.externalTransactionId}`)).body['status']).toBe('PENDING_REFERENCE');
    await Promise.all(workers.map((worker) => worker.close())); workers=[];
    const original=await apis[0]!.request('/wagering/transactions',bet,{ 'idempotency-key': bet.externalTransactionId }); expect(original.status).toBe(200);
    expect((await db.runtime.em.fork().execute<{ count: number }[]>('select count(*)::int as count from outbox_messages where published_at is null'))[0]!.count).toBeGreaterThanOrEqual(2);
    const referenceBet=command(w,'BET','5.00'); referenceBet.externalTransactionId=reference;
    const backlog=[...Array.from({ length: 12 },() => envelope(bet)),envelope(referenceBet),envelope(command(w,'WIN','20.00')),envelope(command(w,'LOSS','0.00')),
      envelope(command(w,'BET','80.00')),envelope(command(w,'BET','80.00'))];
    await Promise.all(backlog.map((input) => queues.send(input,w.id)));
    const queueState=await queues.client.send(new GetQueueAttributesCommand({ QueueUrl: queues.commands,AttributeNames: ['ApproximateNumberOfMessages'] }));
    expect(Number(queueState.Attributes?.['ApproximateNumberOfMessages'] ?? '0')).toBeGreaterThan(0);
    for (const api of apis) api.child.kill('SIGKILL'); await Promise.all(apis.map((api) => api.child.exited)); apis=[];
    const restart=Bun.spawn(['docker','compose','restart','postgres'],{ stdout: 'pipe',stderr: 'pipe' });
    const restartLogs=Promise.all([new Response(restart.stdout).text(),new Response(restart.stderr).text()]);
    expect(await restart.exited).toBe(0); await restartLogs;
    const healthy=Bun.spawn(['docker','compose','up','-d','--wait','--wait-timeout','60','postgres'],{ stdout: 'pipe',stderr: 'pipe' });
    const healthyLogs=Promise.all([new Response(healthy.stdout).text(),new Response(healthy.stderr).text()]);
    expect(await healthy.exited).toBe(0); await healthyLogs;
    await startAll();
    const finalPids=[...apis.map((api) => api.child.pid),...workers.map((worker) => worker.child.pid)];
    expect(new Set(finalPids).size).toBe(6); expect(finalPids.every((pid) => !firstPids.includes(pid))).toBe(true);
    await allInboxes(backlog.map((input) => input.messageId));
    for (const input of pending) await waitFor(() => apis[0]!.request(`/providers/provider/wagering/transactions/${input.data.externalTransactionId}`),(r) => r.body['status']==='PROCESSED');
    const current=await apis[2]!.request(`/wallets/${w.id}`);
    expect(current.body).toMatchObject({ balance: { amount: '35.00',currency: 'BRL' },version: 7 });
    expect((await apis[0]!.request(`/wallets/${w.id}/reconciliation`,{})).body).toMatchObject({ consistent: true,checkedEntries: 7,
      storedBalance: { amount: '35.00',currency: 'BRL' },calculatedBalance: { amount: '35.00',currency: 'BRL' } });
    expect(await apis[1]!.request('/wagering/transactions',bet,{ 'idempotency-key': bet.externalTransactionId })).toEqual({ status: 200,body: { ...original.body,idempotentReplay: true } });
    const refund=pending[0]!; const { idempotencyKey,...refundInput }=refund.data;
    const replay=await apis[0]!.request('/wagering/transactions',refundInput,{ 'idempotency-key': idempotencyKey });
    expect(replay.status).toBe(202); expect(replay.body['status']).toBe('PENDING_REFERENCE'); expect(replay.body['balance']).toEqual({ amount: '100.00',currency: 'BRL' });
    expect(await db.runtime.em.fork().execute('select status,count(*)::int as count from wager_transactions group by status order by status')).toEqual([{ status: 'PROCESSED',count: 8 },{ status: 'REJECTED',count: 1 }]);
    expect(await db.runtime.em.fork().execute("select count(*)::int as count from inbox_messages where consumer_name='wager-transactions-v1'")).toEqual([{ count: 19 }]);
    await waitFor(async () => (await db.runtime.em.fork().execute<{ count: number }[]>('select count(*)::int as count from outbox_messages where published_at is null'))[0]?.count===0,(done) => done);
    const expected=await db.runtime.em.fork().execute<{ id: string }[]>('select id from outbox_messages'); expect(expected).toHaveLength(18);
    const delivered=new Set<string>(); const deadline=Date.now()+15000;
    while (delivered.size<expected.length && Date.now()<deadline) {
      const received=await queues.client.send(new ReceiveMessageCommand({ QueueUrl: queues.events,MaxNumberOfMessages: 10,WaitTimeSeconds: 1,VisibilityTimeout: 30 }));
      for (const message of received.Messages ?? []) {
        const payload=JSON.parse(message.Body!); delivered.add(payload.eventId);
        await queues.client.send(new DeleteMessageCommand({ QueueUrl: queues.events,ReceiptHandle: message.ReceiptHandle! }));
      }
    }
    // O Set observa entregas; a deduplicação de efeitos é comprovada com inbox persistente em E10/E11.
    expect([...delivered].sort()).toEqual(expected.map((row) => row.id).sort());
    await assertReconciled(db.runtime.em.fork(),w.id);
    console.log(JSON.stringify({ event: 'system_recovery_evidence',firstPids,finalPids,transactions: 9,ledgerEntries: 7,inboxes: 19,events: 18 }));
  },60000);
  test('HTTP distingue payload inválido, header ausente, recurso inexistente e conflito', async () => {
    const invalid=await fetch(`${apis[0]!.url}/wagering/transactions`,{ method: 'POST',headers: { 'content-type': 'application/json' },body: '{invalid-json' });
    expect(invalid.status).toBe(400); expect(await invalid.json()).toEqual({ code: 'INVALID_PAYLOAD' });
    expect((await apis[0]!.request('/wallets/missing')).status).toBe(404);
    const [wallet]=await db.runtime.em.fork().execute<{ id: string; player_id: string }[]>('select id,player_id from wallets limit 1');
    const input=command({ id: wallet!.id,playerId: wallet!.player_id },'BET','1.00');
    expect((await apis[0]!.request('/wagering/transactions',input)).body['code']).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const [existing]=await db.runtime.em.fork().execute<{ idempotency_key: string }[]>('select idempotency_key from wager_transactions where idempotency_key is not null limit 1');
    const conflict=await apis[0]!.request('/wagering/transactions',input,{ 'idempotency-key': existing!.idempotency_key });
    expect(conflict.status).toBe(409); expect(conflict.body['code']).toBe('IDEMPOTENCY_CONFLICT');
    expect((await apis[0]!.request('/health/live')).status).toBe(200);
    expect((await apis[0]!.request('/health/ready')).status).toBe(200);
  });
});
