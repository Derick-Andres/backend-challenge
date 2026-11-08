import { Injectable, Module } from '@nestjs/common';
import { ProviderIdentityPort } from '../../application/identity/provider-identity.port.js';
import type { ProviderIdentity } from '../../application/identity/provider-identity.port.js';

@Injectable()
class DevelopmentProviderIdentity extends ProviderIdentityPort {
  override identify(declaredProviderId: string): Promise<ProviderIdentity> {
    return Promise.resolve({ providerId: declaredProviderId, authenticated: false });
  }
}

@Module({
  providers: [{ provide: ProviderIdentityPort, useClass: DevelopmentProviderIdentity }],
  exports: [ProviderIdentityPort],
})
export class IdentityModule {}
