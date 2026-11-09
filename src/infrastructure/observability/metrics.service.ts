import { MikroORM } from '@mikro-orm/postgresql';
import { GetQueueAttributesCommand, GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG } from '../../config/configuration.js';
import type { AppConfig } from '../../config/configuration.js';
import { WagerTransactionStatus } from '../../domain/wager-transaction.js';
import { queueNames } from '../sqs/sqs.module.js';
import { Telemetry } from './telemetry.js';

@Injectable()
export class MetricsService {
  constructor(@Inject(MikroORM) private readonly orm: MikroORM,@Inject(SQSClient) private readonly sqs: SQSClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,@Inject(Telemetry) private readonly telemetry: Telemetry) {}
  private async bounded<T>(operation: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([operation,new Promise<never>((_,reject) => { timer=setTimeout(() => reject(new Error('metrics deadline')),this.config.HEALTH_TIMEOUT_MS); })]); }
    finally { clearTimeout(timer); }
  }
  async render(): Promise<string> {
    const lines=[this.telemetry.render()];
    const [database,sqs]=await Promise.allSettled([
      this.bounded((async () => {
        const statuses=await this.orm.em.fork().execute<{ status: string; count: string }[]>('select status,count(*)::text as count from wager_transactions group by status');
        const [outbox]=await this.orm.em.fork().execute<{ count: string; lag: string }[]>(`select count(*)::text as count,
          greatest(coalesce(extract(epoch from now()-min(occurred_at)),0),0)::text as lag from outbox_messages where published_at is null`);
        const [locks]=await this.orm.em.fork().execute<{ count: string }[]>("select count(*)::text as count from pg_stat_activity where datname=current_database() and application_name like 'backend-challenge:%' and wait_event_type='Lock'");
        return { statuses,outbox,locks };
      })()),
      (async () => {
        const abortSignal=AbortSignal.timeout(this.config.HEALTH_TIMEOUT_MS);
        const url=await this.sqs.send(new GetQueueUrlCommand({ QueueName: queueNames(this.config.SQS_QUEUE_PREFIX)[1] }),{ abortSignal });
        const attributes=await this.sqs.send(new GetQueueAttributesCommand({ QueueUrl: url.QueueUrl!,AttributeNames: ['ApproximateNumberOfMessages','ApproximateNumberOfMessagesNotVisible'] }),{ abortSignal });
        return Number(attributes.Attributes?.['ApproximateNumberOfMessages'] ?? '0')+Number(attributes.Attributes?.['ApproximateNumberOfMessagesNotVisible'] ?? '0');
      })(),
    ]);
    lines.push('# TYPE wager_transactions gauge');
    for (const status of Object.values(WagerTransactionStatus)) lines.push(`wager_transactions{status="${status}"} ${database.status==='fulfilled' ? Number(database.value.statuses.find((row) => row.status===status)?.count ?? '0') : 0}`);
    lines.push('# TYPE wager_outbox_pending gauge',`wager_outbox_pending ${database.status==='fulfilled' ? Number(database.value.outbox?.count ?? '0') : 0}`,
      '# TYPE wager_outbox_lag_seconds gauge',`wager_outbox_lag_seconds ${database.status==='fulfilled' ? Number(database.value.outbox?.lag ?? '0') : 0}`,
      '# TYPE wager_wallet_lock_waits gauge',`wager_wallet_lock_waits ${database.status==='fulfilled' ? Number(database.value.locks?.count ?? '0') : 0}`,
      '# TYPE wager_dlq_messages gauge',`wager_dlq_messages ${sqs.status==='fulfilled' ? sqs.value : 0}`,
      '# TYPE wager_metrics_dependency_up gauge',`wager_metrics_dependency_up{dependency="postgres"} ${database.status==='fulfilled' ? 1 : 0}`,
      `wager_metrics_dependency_up{dependency="sqs"} ${sqs.status==='fulfilled' ? 1 : 0}`);
    return `${lines.join('\n')}\n`;
  }
}
