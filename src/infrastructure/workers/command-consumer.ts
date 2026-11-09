import { ChangeMessageVisibilityCommand, DeleteMessageCommand, GetQueueUrlCommand, ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import type { Message, SQSClient } from '@aws-sdk/client-sqs';
import { z, ZodError } from 'zod';
import { ApplicationError } from '../../application/errors.js';
import { payloadHash, wagerCommandContract } from '../../application/wager-contract.js';
import { identityContract } from '../../application/wallet-service.js';
import type { WageringService } from '../../application/wagering-service.js';
import type { AppConfig } from '../../config/configuration.js';
import { backoffDelay } from '../../domain/backoff.js';
import { BusinessRuleError, DomainValidationError } from '../../domain/errors.js';
import { InvalidMoneyError } from '../../domain/money.js';
import { queueNames } from '../sqs/sqs.module.js';
import { interruptibleDelay } from './reference-loop.js';
import { testGate } from './test-gate.js';
import type { Telemetry } from '../observability/telemetry.js';

export const commandEnvelopeContract = z.object({
  messageId: identityContract,type: z.literal('WagerTransactionRequested'),occurredAt: z.iso.datetime({ offset: true }),
  correlationId: identityContract.optional(),data: wagerCommandContract.extend({ idempotencyKey: identityContract }),
}).strict();

function permanent(error: unknown): boolean {
  return error instanceof SyntaxError || error instanceof ZodError || error instanceof DomainValidationError
    || error instanceof InvalidMoneyError || error instanceof BusinessRuleError
    || (error instanceof ApplicationError && error.status>=400 && error.status<500);
}
function errorCode(error: unknown): string {
  if (error instanceof ApplicationError || error instanceof BusinessRuleError) return error.code;
  if (error instanceof SyntaxError || error instanceof ZodError || error instanceof InvalidMoneyError) return 'INVALID_MESSAGE';
  return error && typeof error==='object' && 'code' in error ? String(error.code) : 'UNEXPECTED';
}

export class CommandConsumer {
  private queueUrl: string | undefined;
  constructor(private readonly sqs: SQSClient,private readonly wagering: WageringService,private readonly config: AppConfig,private readonly telemetry?: Telemetry) {}

  private async url(): Promise<string> {
    if (!this.queueUrl) {
      const result = await this.sqs.send(new GetQueueUrlCommand({ QueueName: queueNames(this.config.SQS_QUEUE_PREFIX)[0] }),{ abortSignal: AbortSignal.timeout(this.config.SQS_REQUEST_TIMEOUT_MS) });
      if (!result.QueueUrl) throw new Error('Command queue unavailable'); this.queueUrl=result.QueueUrl;
    }
    return this.queueUrl;
  }
  private async visibility(queueUrl: string,receipt: string,seconds: number) {
    await this.sqs.send(new ChangeMessageVisibilityCommand({ QueueUrl: queueUrl,ReceiptHandle: receipt,VisibilityTimeout: seconds }),
      { abortSignal: AbortSignal.timeout(this.config.SQS_REQUEST_TIMEOUT_MS) });
  }

  async handle(message: Message,queueUrl: string,signal: AbortSignal): Promise<void> {
    const receipt = message.ReceiptHandle;
    if (!receipt) return;
    const parsedCount = Number.parseInt(message.Attributes?.['ApproximateReceiveCount'] ?? '1',10);
    const receiveCount = Number.isSafeInteger(parsedCount) && parsedCount>0 ? parsedCount : 1;
    if (receiveCount>1) this.telemetry?.increment('wager_command_retries_total');
    const context: Record<string,string | number | boolean> = { messageId: message.MessageId ?? 'unknown',receiveCount,pid: process.pid };
    let committed = false;
    let finished = false;
    const release = () => { if (!committed && !finished) void this.visibility(queueUrl,receipt,0).catch(() => undefined); };
    signal.addEventListener('abort',release,{ once: true });
    const renewal = setInterval(() => {
      if (!signal.aborted) void this.visibility(queueUrl,receipt,this.config.COMMAND_VISIBILITY_SECONDS).catch(() => {
        console.error(JSON.stringify({ level: 'error',event: 'visibility_renew_error',...context }));
      });
    },Math.max(100,Math.min(10000,Math.floor(this.config.COMMAND_VISIBILITY_SECONDS*1000/3))));
    try {
      const envelope = commandEnvelopeContract.parse(JSON.parse(message.Body ?? ''));
      const { idempotencyKey,...command } = envelope.data;
      context['messageId']=envelope.messageId; context['correlationId']=envelope.correlationId ?? envelope.messageId;
      context['walletId']=command.walletId; context['providerId']=command.providerId;
      const result = await this.wagering.process(command,idempotencyKey,String(context['correlationId']),{
        consumerName: 'wager-transactions-v1',messageId: envelope.messageId,payloadHash: payloadHash(envelope),receivedAt: new Date(),
      });
      committed=true; context['transactionId']=result.body.transactionId;
      await testGate('after_commit',{ messageId: envelope.messageId,transactionId: result.body.transactionId,walletId: command.walletId });
      // Somente depois da promessa do COMMIT, inclusive constraints diferidas.
      await this.sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl,ReceiptHandle: receipt }),{ abortSignal: AbortSignal.timeout(this.config.SQS_REQUEST_TIMEOUT_MS) });
      console.log(JSON.stringify({ level: 'info',event: 'command_acked',...context,status: result.body.status,replay: result.body.idempotentReplay }));
    } catch (error) {
      const isPermanent = permanent(error);
      console.error(JSON.stringify({ level: isPermanent ? 'warn' : 'error',event: isPermanent ? 'command_permanent' : 'command_retry',
        ...context,committed,code: errorCode(error) }));
      if (!signal.aborted) {
        const delayMs = backoffDelay(receiveCount,Math.random,{ baseDelayMs: this.config.COMMAND_RETRY_BASE_MS,maxDelayMs: this.config.COMMAND_RETRY_MAX_MS });
        await this.visibility(queueUrl,receipt,Math.max(1,Math.min(43200,Math.ceil(delayMs/1000)))).catch(() => undefined);
      }
      // Sem ack. A redrive policy limita recebimentos e encaminha também erros permanentes à DLQ.
    } finally {
      finished=true; clearInterval(renewal); signal.removeEventListener('abort',release);
    }
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const queueUrl = await this.url();
        const result = await this.sqs.send(new ReceiveMessageCommand({ QueueUrl: queueUrl,
          MaxNumberOfMessages: this.config.WORKER_BATCH_SIZE,WaitTimeSeconds: this.config.COMMAND_WAIT_SECONDS,
          VisibilityTimeout: this.config.COMMAND_VISIBILITY_SECONDS,MessageSystemAttributeNames: ['ApproximateReceiveCount'],
        }),{ abortSignal: AbortSignal.any([signal,AbortSignal.timeout((this.config.COMMAND_WAIT_SECONDS+2)*1000)]) });
        await Promise.all((result.Messages ?? []).map((message) => this.handle(message,queueUrl,signal)));
      } catch (error) {
        if (signal.aborted) break;
        console.error(JSON.stringify({ level: 'error',event: 'command_poll_error',code: errorCode(error),pid: process.pid }));
        await interruptibleDelay(this.config.WORKER_POLL_MS,signal);
      }
    }
  }
}
