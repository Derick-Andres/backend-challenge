import { Catch, HttpException, Inject } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { ZodError } from 'zod';
import { ApplicationError } from '../application/errors.js';
import { BusinessRuleError, DomainValidationError } from '../domain/errors.js';
import { InvalidMoneyError } from '../domain/money.js';
import { MoneyPersistenceError } from '../infrastructure/database/money-converter.js';
import { Telemetry } from '../infrastructure/observability/telemetry.js';

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  constructor(@Inject(Telemetry) private readonly telemetry: Telemetry) {}
  catch(exception: unknown, host: ArgumentsHost): void {
    let status = 500; let code = 'INTERNAL_ERROR';
    if (exception instanceof ApplicationError) { status = exception.status; code = exception.code; }
    else if (exception instanceof MoneyPersistenceError) { status = 400; code = 'AMOUNT_OUT_OF_RANGE'; }
    else if (exception instanceof BusinessRuleError) { status = 400; code = exception.code; }
    else if (exception instanceof ZodError || exception instanceof DomainValidationError || exception instanceof InvalidMoneyError) { status = 400; code = 'INVALID_PAYLOAD'; }
    else if (exception instanceof HttpException) { status = exception.getStatus(); code = status===404 ? 'NOT_FOUND' : 'INVALID_PAYLOAD'; }
    else if (exception && typeof exception==='object' && 'code' in exception
      && ['ECONNREFUSED','ECONNRESET','ETIMEDOUT','57P01','57014','40P01','40001','55P03','53300','08006'].includes(String(exception.code))) {
      status = 503; code = 'INFRASTRUCTURE_UNAVAILABLE';
    } else if (exception instanceof Error && (exception.message==='Query read timeout' || exception.message.startsWith('Connection terminated') || exception.message==='timeout exceeded when trying to connect')) {
      status=503; code='INFRASTRUCTURE_UNAVAILABLE';
    }
    const request=host.switchToHttp().getRequest<{ headers: Record<string,unknown>; body?: unknown; params?: Record<string,unknown> }>();
    const header=request.headers['x-correlation-id'];
    const correlationId=typeof header==='string' && header.trim().length>0 ? header : crypto.randomUUID();
    const context: Record<string,string>={ correlationId };
    if (request.body && typeof request.body==='object') for (const field of ['walletId','providerId']) {
      const value=(request.body as Record<string,unknown>)[field]; if (typeof value==='string') context[field]=value;
    }
    for (const field of ['walletId','transactionId','providerId']) {
      const value=request.params?.[field]; if (typeof value==='string') context[field]=value;
    }
    this.telemetry.log(status>=500 ? 'error' : 'warn','http_error',{ status,code,...context });
    host.switchToHttp().getResponse<{ status(code: number): { json(body: unknown): void } }>().status(status).json({ code });
  }
}
