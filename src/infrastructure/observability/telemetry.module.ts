import { Global, Module } from '@nestjs/common';
import { Telemetry, telemetry } from './telemetry.js';
@Global()
@Module({ providers: [{ provide: Telemetry,useValue: telemetry }],exports: [Telemetry] })
export class TelemetryModule {}
