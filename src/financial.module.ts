import { MikroORM } from '@mikro-orm/postgresql';
import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { FinancialDatabase } from './application/financial-database.js';
import { WalletService } from './application/wallet-service.js';
import { ApiExceptionFilter } from './http/api-exception.filter.js';
import { WalletController } from './http/wallet.controller.js';
import { PostgresFinancialDatabase } from './infrastructure/database/postgres-financial-database.js';
import { WageringService } from './application/wagering-service.js';
import { ProviderTransactionController, WageringController } from './http/wagering.controller.js';
import { IdentityModule } from './infrastructure/identity/identity.module.js';
import { APP_CONFIG } from './config/configuration.js';
import type { AppConfig } from './config/configuration.js';
import { testGate } from './infrastructure/workers/test-gate.js';
import { Telemetry } from './infrastructure/observability/telemetry.js';

@Module({
  imports: [IdentityModule],
  providers: [
    { provide: FinancialDatabase, inject: [MikroORM,APP_CONFIG,Telemetry], useFactory: (orm: MikroORM,config: AppConfig,telemetry: Telemetry) => new PostgresFinancialDatabase(orm,
      config.NODE_ENV==='test' && process.env['TEST_GATE'] ? { afterWrite: async (step) => { if (step==='inbox_processed') await testGate('before_commit'); } } : {},telemetry) },
    { provide: WalletService, inject: [FinancialDatabase,Telemetry], useFactory: (database: FinancialDatabase,telemetry: Telemetry) => new WalletService(database,telemetry) },
    { provide: WageringService, inject: [FinancialDatabase,APP_CONFIG,Telemetry], useFactory: (database: FinancialDatabase,config: AppConfig,telemetry: Telemetry) => new WageringService(database,
      { ttlMs: config.REFERENCE_TTL_MS, baseDelayMs: config.REFERENCE_BASE_DELAY_MS, maxDelayMs: config.REFERENCE_MAX_DELAY_MS },undefined,undefined,telemetry) },
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
  ],
  controllers: [WalletController,WageringController,ProviderTransactionController], exports: [FinancialDatabase,WalletService,WageringService],
})
export class FinancialModule {}
