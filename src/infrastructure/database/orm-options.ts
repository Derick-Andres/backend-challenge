import { Migrator } from '@mikro-orm/migrations';
import { defineConfig } from '@mikro-orm/postgresql';
import type { AppConfig } from '../../config/configuration.js';

export function ormOptions(config: AppConfig) {
  return defineConfig({
    host: config.PGHOST,
    port: config.PGPORT,
    dbName: config.PGDATABASE,
    user: config.PGUSER,
    password: config.PGPASSWORD,
    entities: [],
    discovery: { warnWhenNoEntities: false }, // E1: nenhuma entidade financeira.
    allowGlobalContext: false,
    ensureDatabase: false,
    // MikroORM 7 conecta sob demanda; readiness executa uma consulta real.
    preferTs: false, // CLI utiliza migrations compiladas; fonte TS continua versionada.
    pool: { min: 0, max: 5 },
    driverOptions: {
      connectionTimeoutMillis: config.HEALTH_TIMEOUT_MS,
      query_timeout: config.HEALTH_TIMEOUT_MS,
      statement_timeout: config.HEALTH_TIMEOUT_MS,
    },
    extensions: [Migrator],
    migrations: {
      path: './dist/src/infrastructure/database/migrations',
      pathTs: './src/infrastructure/database/migrations',
      glob: 'Migration*.js',
      transactional: true,
      allOrNothing: true,
      snapshot: false,
      emit: 'ts',
    },
  });
}
