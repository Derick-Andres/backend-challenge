import { MikroOrmModule } from '@mikro-orm/nestjs';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { Module } from '@nestjs/common';
import { APP_CONFIG } from './config/configuration.js';
import type { AppConfig } from './config/configuration.js';
import { ConfigurationModule } from './config/configuration.module.js';
import { HealthController } from './health/health.controller.js';
import { HealthService } from './health/health.service.js';
import { ormOptions } from './infrastructure/database/orm-options.js';
import { IdentityModule } from './infrastructure/identity/identity.module.js';
import { SqsModule } from './infrastructure/sqs/sqs.module.js';

@Module({
  imports: [
    ConfigurationModule,
    MikroOrmModule.forRootAsync({
      driver: PostgreSqlDriver,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ormOptions(config),
    }),
    SqsModule,
    IdentityModule,
  ],
  controllers: [HealthController],
  providers: [HealthService],
})
export class AppModule {}
