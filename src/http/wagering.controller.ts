import { Body, Controller, Get, Headers, Inject, Param, Post, Res } from '@nestjs/common';
import { WageringService } from '../application/wagering-service.js';
import { ProviderIdentityPort } from '../application/identity/provider-identity.port.js';
import { wagerCommandContract } from '../application/wager-contract.js';
import { ApplicationError } from '../application/errors.js';
import { identityContract } from '../application/wallet-service.js';

@Controller('wagering/transactions')
export class WageringController {
  constructor(@Inject(WageringService) private readonly wagering: WageringService,
    @Inject(ProviderIdentityPort) private readonly identity: ProviderIdentityPort) {}
  @Get(':transactionId') get(@Param('transactionId') id: string) { return this.wagering.get(id); }
  @Post() async process(@Body() input: unknown, @Headers('idempotency-key') key: string | undefined,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-correlation-id') correlation: string | undefined,
    @Res({ passthrough: true }) response: { status(code: number): void; setHeader(name: string,value: string): void }) {
    const command = wagerCommandContract.parse(input);
    const identity = await this.identity.identify(command.providerId,authorization);
    if (identity.providerId!==command.providerId) throw new ApplicationError(403,'PROVIDER_IDENTITY_MISMATCH');
    const correlationId=identityContract.safeParse(correlation).success ? correlation! : crypto.randomUUID();
    response.setHeader('x-correlation-id',correlationId);
    const result = await this.wagering.process(command,key,correlationId);
    response.status(result.status);
    return result.body;
  }
}

@Controller('providers/:providerId/wagering/transactions')
export class ProviderTransactionController {
  constructor(@Inject(WageringService) private readonly wagering: WageringService) {}
  @Get(':externalTransactionId') get(@Param('providerId') providerId: string, @Param('externalTransactionId') externalId: string) {
    return this.wagering.getByExternal(providerId,externalId);
  }
}
