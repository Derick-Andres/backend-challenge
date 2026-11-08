import { SQSClient } from '@aws-sdk/client-sqs';
import { Inject, Module } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import { APP_CONFIG } from '../../config/configuration.js';
import type { AppConfig } from '../../config/configuration.js';

export const QUEUE_NAMES = [
  'wager-transactions.fifo',
  'wager-transactions-dlq.fifo',
  'wager-events.fifo',
] as const;

@Module({
  providers: [{
    provide: SQSClient,
    inject: [APP_CONFIG],
    useFactory: (config: AppConfig) => new SQSClient({
      endpoint: config.SQS_ENDPOINT,
      region: config.AWS_REGION,
      credentials: {
        accessKeyId: config.AWS_ACCESS_KEY_ID,
        secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
      },
      maxAttempts: 1,
    }),
  }],
  exports: [SQSClient],
})
export class SqsModule implements OnModuleDestroy {
  constructor(@Inject(SQSClient) private readonly client: SQSClient) {}

  onModuleDestroy(): void {
    this.client.destroy();
  }
}
