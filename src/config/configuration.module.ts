import { Global, Module } from '@nestjs/common';
import { APP_CONFIG, loadConfig } from './configuration.js';

@Global()
@Module({
  providers: [{ provide: APP_CONFIG, useFactory: () => loadConfig(process.env) }],
  exports: [APP_CONFIG],
})
export class ConfigurationModule {}
