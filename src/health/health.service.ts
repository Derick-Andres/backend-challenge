import { GetQueueAttributesCommand, GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import { EntityManager } from '@mikro-orm/postgresql';
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG } from '../config/configuration.js';
import type { AppConfig } from '../config/configuration.js';
import { queueNames } from '../infrastructure/sqs/sqs.module.js';

type DependencyStatus = 'up' | 'down';
export interface Readiness {
  status: 'ok' | 'error';
  checks: { postgres: DependencyStatus; sqs: DependencyStatus };
}

@Injectable()
export class HealthService {
  constructor(
    @Inject(EntityManager) private readonly em: EntityManager,
    @Inject(SQSClient) private readonly sqs: SQSClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async readiness(): Promise<Readiness> {
    const [postgres, sqs] = await Promise.all([
      this.check(() => this.em.getContext().execute('select 1')),
      this.check(async () => {
        // Um deadline compartilhado limita toda a verificação das três filas.
        const abortSignal = AbortSignal.timeout(this.config.HEALTH_TIMEOUT_MS);
        await Promise.all(queueNames(this.config.SQS_QUEUE_PREFIX).map(async (QueueName) => {
          const { QueueUrl } = await this.sqs.send(new GetQueueUrlCommand({ QueueName }), { abortSignal });
          if (!QueueUrl) throw new Error('Fila indisponível');
          await this.sqs.send(new GetQueueAttributesCommand({
            QueueUrl, AttributeNames: ['QueueArn'],
          }), { abortSignal });
        }));
      }),
    ]);
    return {
      status: postgres === 'up' && sqs === 'up' ? 'ok' : 'error',
      checks: { postgres, sqs },
    };
  }

  private async check(operation: () => Promise<unknown>): Promise<DependencyStatus> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        operation(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Health timeout')), this.config.HEALTH_TIMEOUT_MS);
        }),
      ]);
      return 'up';
    } catch {
      return 'down';
    } finally {
      clearTimeout(timer);
    }
  }
}
