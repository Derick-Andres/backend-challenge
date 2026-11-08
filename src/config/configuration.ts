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
  AWS_REGION: z.string().min(1),
  AWS_ACCESS_KEY_ID: z.string().min(1),
  AWS_SECRET_ACCESS_KEY: z.string().min(1),
  SQS_ENDPOINT: z.url().refine((value) => {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  }, 'deve ser URL HTTP(S) sem credenciais'),
});

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
