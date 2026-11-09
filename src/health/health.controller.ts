import { Controller, Get, Inject, Res } from '@nestjs/common';
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
  async ready(@Res({ passthrough: true }) response: { status(code: number): void }): Promise<Readiness> {
    const result = await this.health.readiness();
    // Readiness é um contrato operacional, não um erro de negócio sanitizado.
    if (result.status === 'error') response.status(503);
    return result;
  }
}
