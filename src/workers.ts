import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { FinancialDatabase } from './application/financial-database.js';
import { WageringService } from './application/wagering-service.js';
import { APP_CONFIG } from './config/configuration.js';
import type { AppConfig } from './config/configuration.js';
import { referenceLoop } from './infrastructure/workers/reference-loop.js';
import { SQSClient } from '@aws-sdk/client-sqs';
import { CommandConsumer } from './infrastructure/workers/command-consumer.js';
import { OutboxPublisher } from './infrastructure/workers/outbox-publisher.js';
import { MikroORM } from '@mikro-orm/postgresql';
import { JsonLogger, Telemetry, telemetry } from './infrastructure/observability/telemetry.js';
import { MetricsService } from './infrastructure/observability/metrics.service.js';

const app = await NestFactory.createApplicationContext(AppModule,{ logger: new JsonLogger(telemetry) });
const config = app.get<AppConfig>(APP_CONFIG);
const controller = new AbortController();
let shutdownDeadline: ReturnType<typeof setTimeout> | undefined;
const stop = () => {
  controller.abort();
  shutdownDeadline ??= setTimeout(() => process.exit(1),20_000);
};
process.once('SIGTERM',stop); process.once('SIGINT',stop);
const metricsServer=Bun.serve({ hostname: config.HOST,port: config.WORKER_METRICS_PORT,fetch: async (request) =>
  new URL(request.url).pathname==='/metrics' ? new Response(await app.get(MetricsService).render(),{ headers: { 'content-type': 'text/plain; version=0.0.4' } }) : new Response('Not found',{ status: 404 }) });
console.log(JSON.stringify({ level: 'info', event: 'workers_started', roles: config.WORKER_ROLES, pid: process.pid,metricsPort: metricsServer.port }));
try {
  const roles = config.WORKER_ROLES.split(',');
  const jobs: Promise<void>[] = [];
  if (roles.includes('references')) jobs.push(referenceLoop(app.get(FinancialDatabase),app.get(WageringService),{ pollMs: config.WORKER_POLL_MS,batchSize: config.WORKER_BATCH_SIZE },controller.signal));
  if (roles.includes('commands')) jobs.push(new CommandConsumer(app.get(SQSClient),app.get(WageringService),config,app.get(Telemetry)).run(controller.signal));
  if (roles.includes('publisher')) jobs.push(new OutboxPublisher(app.get(MikroORM),app.get(SQSClient),config,undefined,undefined,app.get(Telemetry)).run(controller.signal));
  await Promise.all(jobs);
} finally { clearTimeout(shutdownDeadline); metricsServer.stop(true); await app.close(); if (process.connected) process.disconnect?.(); }
