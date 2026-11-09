import { IsolationLevel } from '@mikro-orm/core';
import type { MikroORM } from '@mikro-orm/postgresql';
import { GetQueueUrlCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { AppConfig } from '../../config/configuration.js';
import { OutboxMessage } from '../../domain/outbox-message.js';
import { outboxSchema } from '../database/records.js';
import { queueNames } from '../sqs/sqs.module.js';
import { interruptibleDelay } from './reference-loop.js';
import { testGate } from './test-gate.js';
import type { Telemetry } from '../observability/telemetry.js';

export class OutboxPublisher {
  private queueUrl: string | undefined;
  constructor(private readonly orm: MikroORM,private readonly sqs: SQSClient,private readonly config: AppConfig,
    private readonly clock: () => Date = () => new Date(),private readonly random: () => number = Math.random,private readonly telemetry?: Telemetry) {}

  private async url(): Promise<string> {
    if (!this.queueUrl) {
      const result=await this.sqs.send(new GetQueueUrlCommand({ QueueName: queueNames(this.config.SQS_QUEUE_PREFIX)[2] }),{ abortSignal: AbortSignal.timeout(this.config.SQS_REQUEST_TIMEOUT_MS) });
      if (!result.QueueUrl) throw new Error('Events queue unavailable'); this.queueUrl=result.QueueUrl;
    }
    return this.queueUrl;
  }

  async publishOne(): Promise<boolean> {
    const queueUrl=await this.url();
    return this.orm.em.fork().transactional(async (em) => {
      const [candidate]=await em.execute<{ id: string }[]>(`select id from outbox_messages
        where published_at is null and next_attempt_at<=? order by next_attempt_at,occurred_at,id limit 1 for update skip locked`,[this.clock()]);
      if (!candidate) { await testGate('empty_outbox_selection'); return false; }
      const row=await em.findOneOrFail(outboxSchema,candidate.id);
      const message=OutboxMessage.rehydrate({ id: row.id,aggregateId: row.aggregateId,eventType: row.eventType,payload: row.payload,
        occurredAt: row.occurredAt,attempts: row.attempts,nextAttemptAt: row.nextAttemptAt,
        ...(row.publishedAt===null ? {} : { publishedAt: row.publishedAt }) });
      const data=message.payload['data'] as Record<string,unknown> | undefined;
      const walletId=typeof data?.['walletId']==='string' ? data['walletId'] : message.aggregateId;
      const context={ eventId: message.id,messageId: message.id,walletId,aggregateId: message.aggregateId,
        correlationId: message.payload['correlationId'],transactionId: data?.['transactionId'],providerId: data?.['providerId'],pid: process.pid };
      await testGate('before_send',{ eventId: message.id });
      if (message.attempts>0) this.telemetry?.increment('wager_outbox_retries_total');
      try {
        await this.sqs.send(new SendMessageCommand({ QueueUrl: queueUrl,MessageBody: JSON.stringify(message.payload),
          MessageGroupId: walletId,MessageDeduplicationId: message.id }),{ abortSignal: AbortSignal.timeout(this.config.SQS_REQUEST_TIMEOUT_MS) });
        await testGate('after_send',{ eventId: message.id });
      } catch (error) {
        message.scheduleRetry(this.clock(),this.random,{ baseDelayMs: this.config.OUTBOX_RETRY_BASE_MS,maxDelayMs: this.config.OUTBOX_RETRY_MAX_MS });
        em.assign(row,{ attempts: message.attempts,nextAttemptAt: message.nextAttemptAt! });
        await em.flush();
        console.error(JSON.stringify({ level: 'error',event: 'outbox_retry',...context,attempts: message.attempts,
          code: error && typeof error==='object' && 'name' in error ? String(error.name) : 'UNEXPECTED' }));
        return true;
      }
      // Erro SQL/COMMIT após envio deve fazer rollback; não se agenda em uma transação abortada.
      message.markPublished(this.clock());
      em.assign(row,{ publishedAt: message.publishedAt! });
      await em.flush();
      console.log(JSON.stringify({ level: 'info',event: 'outbox_sent',...context }));
      return true;
    },{ isolationLevel: IsolationLevel.READ_COMMITTED });
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try { if (await this.publishOne()) continue; }
      catch (error) { console.error(JSON.stringify({ level: 'error',event: 'outbox_poll_error',pid: process.pid,
        code: error && typeof error==='object' && 'code' in error ? String(error.code) : 'UNEXPECTED' })); }
      await interruptibleDelay(this.config.WORKER_POLL_MS,signal);
    }
  }
}
