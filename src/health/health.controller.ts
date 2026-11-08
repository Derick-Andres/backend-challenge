import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { HealthService } from './health.service.js';
import type { Readiness } from './health.service.js';

@Controller('health')
export class HealthController {
  constructor(@Inject(HealthService) private readonly health: HealthService) {}

  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(): Promise<Readiness> {
    const result = await this.health.readiness();
    if (result.status === 'error') throw new ServiceUnavailableException(result);
    return result;
  }
}
