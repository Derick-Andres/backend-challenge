import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { GetQueueAttributesCommand, GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import { RequestContext } from '@mikro-orm/core';
import { MikroORM } from '@mikro-orm/postgresql';
import { loadConfig } from '../src/config/configuration.js';
import { ormOptions } from '../src/infrastructure/database/orm-options.js';
import { QUEUE_NAMES } from '../src/infrastructure/sqs/sqs.module.js';
import { ProviderIdentityPort } from '../src/application/identity/provider-identity.port.js';
import type { Readiness } from '../src/health/health.service.js';

const config = loadConfig(process.env);
const paused = new Set<string>();
const stopped = new Set<string>();
let server: ReturnType<typeof Bun.spawn> | undefined;
let logs: Promise<string> | undefined;
let baseUrl: string;
let orm: MikroORM;
const sqs = new SQSClient({
  endpoint: config.SQS_ENDPOINT, region: config.AWS_REGION, maxAttempts: 1,
  credentials: { accessKeyId: config.AWS_ACCESS_KEY_ID, secretAccessKey: config.AWS_SECRET_ACCESS_KEY },
});

async function compose(...args: string[]): Promise<string> {
  const child = Bun.spawn(['docker', 'compose', ...args], { stdout: 'pipe', stderr: 'pipe' });
  const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  const exit = await child.exited;
  const [stdout, stderr] = await output;
  if (exit !== 0) throw new Error(`docker compose ${args.join(' ')} falhou: ${stdout}\n${stderr}`);
  return stdout;
}

async function waitInfrastructureHealthy(): Promise<void> {
  const until = Date.now() + 20000;
  while (Date.now() < until) {
    const status = await compose('ps', '--format', '{{.Service}} {{.Health}}');
    if (status.includes('postgres healthy') && status.includes('localstack healthy')) return;
    await Bun.sleep(200);
  }
  throw new Error('Healthchecks dos containers não se recuperaram em 20s');
}

async function health(endpoint: 'live'): Promise<{ status: number; body: { status: 'ok' } }>;
async function health(endpoint: 'ready'): Promise<{ status: number; body: Readiness }>;
async function health(endpoint: 'live' | 'ready') {
  const response = await fetch(`${baseUrl}/health/${endpoint}`, {
    signal: AbortSignal.timeout(config.HEALTH_TIMEOUT_MS + 2000),
  });
  return { status: response.status, body: await response.json() as Readiness | { status: 'ok' } };
}

async function waitReady(): Promise<void> {
  const until = Date.now() + 20000;
  while (Date.now() < until) {
    try {
      if ((await health('ready')).status === 200) return;
    } catch { /* Socket/pool podem estar reconectando. */ }
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      throw new Error(`Aplicação encerrou: ${await logs}`);
    }
    await Bun.sleep(100);
  }
  throw new Error('Readiness não se recuperou em 20s');
}

async function queueAttributes(name: string) {
  const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: name }));
  if (!QueueUrl) throw new Error(`Fila ausente: ${name}`);
  const { Attributes } = await sqs.send(new GetQueueAttributesCommand({
    QueueUrl, AttributeNames: ['QueueArn', 'FifoQueue', 'RedrivePolicy', 'VisibilityTimeout'],
  }));
  return Attributes ?? {};
}

describe('E1 com PostgreSQL e LocalStack reais', () => {
  beforeAll(async () => {
    await compose('up', '-d', '--wait', '--wait-timeout', '120');
    const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
    const port = reservation.port;
    reservation.stop(true);
    baseUrl = `http://127.0.0.1:${port}`;
    const child = Bun.spawn([process.execPath, 'dist/src/main.js'], {
      env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' },
      stdout: 'pipe', stderr: 'pipe',
    });
    server = child;
    logs = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
      .then((parts) => parts.join('\n'));
    await waitReady();
    orm = await MikroORM.init(ormOptions(config));
  });

  afterAll(async () => {
    // Restaurar somente os serviços deste Compose, sem remover volumes.
    try {
      for (const service of paused) await compose('unpause', service);
      if (stopped.size > 0) await compose('up', '-d', '--wait', '--wait-timeout', '120', ...stopped);
      await waitInfrastructureHealthy();
    } finally {
      if (server && server.exitCode === null) {
        server.kill('SIGTERM');
        await server.exited;
      }
      await orm?.close(true);
      sqs.destroy();
    }
  });

  test('liveness aberto e readiness consulta DB e as três filas', async () => {
    expect(await health('live')).toEqual({ status: 200, body: { status: 'ok' } });
    expect(await health('ready')).toEqual({
      status: 200, body: { status: 'ok', checks: { postgres: 'up', sqs: 'up' } },
    });
  });

  test('filas FIFO, redrive e bootstrap repetível sem apagar recursos', async () => {
    await compose('exec', '-T', 'localstack', 'bash', '/etc/localstack/init/ready.d/10-init-sqs.sh');
    for (const name of QUEUE_NAMES) expect((await queueAttributes(name)).FifoQueue).toBe('true');
    const command = await queueAttributes('wager-transactions.fifo');
    const dlq = await queueAttributes('wager-transactions-dlq.fifo');
    expect(JSON.parse(command.RedrivePolicy ?? '{}')).toEqual({
      deadLetterTargetArn: dlq.QueueArn, maxReceiveCount: 5,
    });
    expect(command.VisibilityTimeout).toBe('30');
  });

  test('EntityManagers são isolados em execuções sobrepostas e contexto global é proibido', async () => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    let arrived = 0;
    const execute = () => RequestContext.create(orm.em, async () => {
      const em = orm.em.getContext();
      if (++arrived === 2) release();
      await barrier;
      await em.execute('select 1');
      expect(orm.em.getContext()).toBe(em);
      return em;
    });
    const [first, second] = await Promise.all([execute(), execute()]);
    expect(first).not.toBe(second);
    expect(() => orm.em.getContext()).toThrow();
  });

  test('E1 não cria tabelas financeiras', async () => {
    const tables = await orm.em.fork().execute<{ table_name: string }[]>(
      "select table_name from information_schema.tables where table_schema = 'public'",
    );
    expect(tables.filter(({ table_name }) => table_name !== 'mikro_orm_migrations')).toEqual([]);
  });

  for (const dependency of ['postgres', 'localstack'] as const) {
    test(`readiness falha com ${dependency} parado e liveness continua; recupera sem reiniciar API`, async () => {
      await compose('stop', '-t', '1', dependency);
      stopped.add(dependency);
      try {
        expect((await health('live')).status).toBe(200);
        const ready = await health('ready');
        expect(ready.status).toBe(503);
        expect(ready.body.checks[dependency === 'postgres' ? 'postgres' : 'sqs']).toBe('down');
      } finally {
        await compose('up', '-d', '--wait', '--wait-timeout', '120', dependency);
        stopped.delete(dependency);
        await waitReady();
      }
    });

    test(`deadline com ${dependency} pausado, sem bloquear liveness`, async () => {
      await compose('pause', dependency);
      paused.add(dependency);
      try {
        const started = performance.now();
        const [ready, live] = await Promise.all([health('ready'), health('live')]);
        expect(ready.status).toBe(503);
        expect(live.status).toBe(200);
        expect(performance.now() - started).toBeLessThan(config.HEALTH_TIMEOUT_MS + 1500);
      } finally {
        await compose('unpause', dependency);
        paused.delete(dependency);
        await waitReady();
      }
    });
  }

  test('ProviderIdentityPort está registrado e não afirma autenticação', async () => {
    const { NestFactory } = await import('@nestjs/core');
    const { AppModule } = await import('../src/app.module.js');
    const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
    try {
      const identity = await app.get(ProviderIdentityPort).identify('provider-a');
      expect(identity).toEqual({ providerId: 'provider-a', authenticated: false });
    } finally {
      await app.close();
    }
  });
});
