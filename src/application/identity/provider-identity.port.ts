export interface ProviderIdentity {
  readonly providerId: string;
  readonly authenticated: boolean;
}

// Extensão para um futuro adaptador OIDC; não autentica mensagens do canal interno.
export abstract class ProviderIdentityPort {
  abstract identify(declaredProviderId: string, authorization?: string): Promise<ProviderIdentity>;
}
