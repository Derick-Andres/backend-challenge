import { loadConfig } from './src/config/configuration.js';
import { ormOptions } from './src/infrastructure/database/orm-options.js';

export default ormOptions(loadConfig(process.env));
