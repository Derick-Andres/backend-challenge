import { loadConfig } from './src/config/configuration.js';
import { ormOptions } from './src/infrastructure/database/orm-options.js';

const config = loadConfig(process.env);
export default ormOptions({ ...config, PGUSER: config.PG_MIGRATION_USER, PGPASSWORD: config.PG_MIGRATION_PASSWORD });
