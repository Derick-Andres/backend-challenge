import { z } from 'zod';

const integer = (min: number, max: number) =>
  z.string().regex(/^[0-9]+$/, 'deve ser inteiro decimal')
    .transform(Number).pipe(z.number().int().min(min).max(max));

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: integer(1, 65535).default(3000),
  HEALTH_TIMEOUT_MS: integer(100, 10000).default(1000),
  PGHOST: z.string().min(1),
  PGPORT: integer(1, 65535),
  PGDATABASE: z.string().min(1),
  PGUSER: z.string().min(1),
  PGPASSWORD: z.string().min(1),
  PG_MIGRATION_USER: z.string().min(1).default('wagering'),
  PG_MIGRATION_PASSWORD: z.string().min(1).default('local-development-only'),
  DB_TIMEOUT_MS: integer(100, 120000).default(10000),
  REFERENCE_TTL_MS: integer(50, 604800000).default(86400000),
  REFERENCE_BASE_DELAY_MS: integer(10, 3600000).default(5000),
  REFERENCE_MAX_DELAY_MS: integer(10, 3600000).default(300000),
  WORKER_POLL_MS: integer(10, 60000).default(1000),
  WORKER_BATCH_SIZE: integer(1, 10).default(5),
  WORKER_METRICS_PORT: integer(0,65535).default(0),
  WORKER_ROLES: z.string().default('references,commands,publisher').refine((value) => value.split(',').every((role) => ['references','commands','publisher'].includes(role))),
  SQS_QUEUE_PREFIX: z.string().regex(/^[a-z0-9-]{1,40}$/).default('wager'),
  SQS_REQUEST_TIMEOUT_MS: integer(100,10000).default(2000),
  COMMAND_VISIBILITY_SECONDS: integer(1,43200).default(30),
  COMMAND_WAIT_SECONDS: integer(1,20).default(10),
  COMMAND_RETRY_BASE_MS: integer(10,300000).default(1000),
  COMMAND_RETRY_MAX_MS: integer(10,300000).default(300000),
  OUTBOX_RETRY_BASE_MS: integer(10,60000).default(1000),
  OUTBOX_RETRY_MAX_MS: integer(10,600000).default(60000),
  AWS_REGION: z.string().min(1),
  AWS_ACCESS_KEY_ID: z.string().min(1),
  AWS_SECRET_ACCESS_KEY: z.string().min(1),
  SQS_ENDPOINT: z.url().refine((value) => {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  }, 'deve ser URL HTTP(S) sem credenciais'),
}).refine((config) => config.REFERENCE_MAX_DELAY_MS>=config.REFERENCE_BASE_DELAY_MS, {
  path: ['REFERENCE_MAX_DELAY_MS'], message: 'deve ser >= REFERENCE_BASE_DELAY_MS',
}).refine((config) => config.COMMAND_RETRY_MAX_MS>=config.COMMAND_RETRY_BASE_MS,{ path: ['COMMAND_RETRY_MAX_MS'],message: 'deve ser >= COMMAND_RETRY_BASE_MS' })
  .refine((config) => config.OUTBOX_RETRY_MAX_MS>=config.OUTBOX_RETRY_BASE_MS,{ path: ['OUTBOX_RETRY_MAX_MS'],message: 'deve ser >= OUTBOX_RETRY_BASE_MS' });

export type AppConfig = z.infer<typeof environmentSchema>;
export const APP_CONFIG = Symbol('APP_CONFIG');

export function loadConfig(environment: Record<string, string | undefined>): AppConfig {
  const result = environmentSchema.safeParse(environment);
  if (!result.success) {
    // Nomes dos campos bastam para diagnosticar; nunca imprimir valores recebidos.
    const fields = [...new Set(result.error.issues.map((issue) => issue.path.join('.')))];
    throw new Error(`Configuração inválida: ${fields.join(', ')}`);
  }
  return Object.freeze(result.data);
}
