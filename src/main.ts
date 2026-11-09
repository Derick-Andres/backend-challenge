import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { APP_CONFIG } from './config/configuration.js';
import type { AppConfig } from './config/configuration.js';
import { JsonLogger, telemetry } from './infrastructure/observability/telemetry.js';

const app = await NestFactory.create(AppModule,{ logger: new JsonLogger(telemetry) });
const config = app.get<AppConfig>(APP_CONFIG);
app.enableShutdownHooks();
await app.listen(config.PORT, config.HOST);
