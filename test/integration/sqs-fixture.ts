import { CreateQueueCommand, DeleteQueueCommand, GetQueueAttributesCommand, ReceiveMessageCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { AppConfig } from '../../src/config/configuration.js';
import { queueNames } from '../../src/infrastructure/sqs/sqs.module.js';

export async function isolatedQueues(config: AppConfig) {
  const client = new SQSClient({ endpoint: config.SQS_ENDPOINT,region: config.AWS_REGION,maxAttempts: 1,
    credentials: { accessKeyId: config.AWS_ACCESS_KEY_ID,secretAccessKey: config.AWS_SECRET_ACCESS_KEY } });
  const prefix = `challenge-${crypto.randomUUID().replaceAll('-','').slice(0,20)}`;
  const names = queueNames(prefix); const created: string[] = [];
  const close = async () => { for (const QueueUrl of [...created].reverse()) await client.send(new DeleteQueueCommand({ QueueUrl })); client.destroy(); };
  const create = async (name: string,extra: Record<string,string> = {}) => {
    const result = await client.send(new CreateQueueCommand({ QueueName: name,Attributes: { FifoQueue: 'true',ContentBasedDeduplication: 'false',VisibilityTimeout: '1',...extra } }));
    if (!result.QueueUrl) throw new Error('Queue sem URL'); created.push(result.QueueUrl); return result.QueueUrl;
  };
  try {
    const dlq = await create(names[1]);
    const attributes = await client.send(new GetQueueAttributesCommand({ QueueUrl: dlq,AttributeNames: ['QueueArn'] }));
    const commands = await create(names[0],{ RedrivePolicy: JSON.stringify({ deadLetterTargetArn: attributes.Attributes?.['QueueArn'],maxReceiveCount: 5 }) });
    const events = await create(names[2]);
    return { client,commands,dlq,events,config: { ...config,SQS_QUEUE_PREFIX: prefix },close,
      async send(input: unknown,group: string = crypto.randomUUID()) {
        return client.send(new SendMessageCommand({ QueueUrl: commands,MessageBody: typeof input==='string' ? input : JSON.stringify(input),
          MessageGroupId: group,MessageDeduplicationId: crypto.randomUUID() }));
      },
      async receive(url = commands) { return client.send(new ReceiveMessageCommand({ QueueUrl: url,MaxNumberOfMessages: 10,WaitTimeSeconds: 1,
        VisibilityTimeout: 1,MessageSystemAttributeNames: ['ApproximateReceiveCount'] })); },
    };
  } catch (error) { await close(); throw error; }
}
