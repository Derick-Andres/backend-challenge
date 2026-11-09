import { MikroORM } from '@mikro-orm/postgresql';
import { loadConfig } from '../../src/config/configuration.js';
import { ormOptions } from '../../src/infrastructure/database/orm-options.js';
import { grantRuntimeAccess, prepareRuntimeRole } from '../../src/infrastructure/database/runtime-role.js';

const config = loadConfig(process.env);
if (config.PGUSER === config.PG_MIGRATION_USER) throw new Error('Configure PGUSER como papel runtime separado do migrador');
const orm = await MikroORM.init(ormOptions({ ...config, PGUSER: config.PG_MIGRATION_USER, PGPASSWORD: config.PG_MIGRATION_PASSWORD }));
try {
  await prepareRuntimeRole(orm.em.fork(), config.PGUSER, config.PGPASSWORD);
  await orm.migrator.up();
  await grantRuntimeAccess(orm.em.fork(), config.PGUSER);
  console.log('Database pronta: migrations aplicadas e papel runtime restrito');
} finally { await orm.close(true); }
