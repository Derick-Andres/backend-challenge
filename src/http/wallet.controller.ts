import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query, Res } from '@nestjs/common';
import { WalletService, identityContract } from '../application/wallet-service.js';

@Controller('wallets')
export class WalletController {
  constructor(@Inject(WalletService) private readonly wallets: WalletService) {}
  @Post() open(@Body() body: unknown,@Headers('x-correlation-id') correlation: string | undefined,
    @Res({ passthrough: true }) response: { setHeader(name: string,value: string): void }) {
    const correlationId=identityContract.safeParse(correlation).success ? correlation! : crypto.randomUUID();
    response.setHeader('x-correlation-id',correlationId); return this.wallets.open(body,correlationId);
  }
  @Get(':walletId') get(@Param('walletId') id: string) { return this.wallets.get(id); }
  @Post(':walletId/reconciliation') @HttpCode(200) reconcile(@Param('walletId') id: string) { return this.wallets.reconcile(id); }
  @Get(':walletId/ledger') ledger(@Param('walletId') id: string, @Query('cursor') cursor?: string, @Query('limit') limit?: string) {
    return this.wallets.ledger(id,{ ...(cursor===undefined ? {} : { cursor }), ...(limit===undefined ? {} : { limit }) });
  }
}
